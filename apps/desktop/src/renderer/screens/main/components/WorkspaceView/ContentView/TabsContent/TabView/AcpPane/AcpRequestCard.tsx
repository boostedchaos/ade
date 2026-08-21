import {
	Tool,
	ToolContent,
	type ToolDisplayState,
	ToolHeader,
} from "@superset/ui/ai-elements/tool";
import { Button } from "@superset/ui/button";
import { Checkbox } from "@superset/ui/checkbox";
import { Input } from "@superset/ui/input";
import { memo, useState } from "react";
import {
	type AcpElicitationGroup,
	type AcpElicitationSelections,
	buildElicitationContent,
	canSubmitElicitation,
	describeElicitationAnswer,
	groupElicitationFields,
} from "./elicitationForm";
import type {
	AcpElicitationField,
	AcpRequestEntry,
	AcpRequestOutcome,
} from "./transcript";

/**
 * The agent is blocked on the user: a permission request or a question, in the
 * scrollback where it happened (B2).
 *
 * Deliberately the tool card's own idiom (`Tool` / `ToolHeader` /
 * `ToolContent`) rather than a modal: a dialog would cover the transcript that
 * explains WHY the agent is asking, and a pane in a background tab would raise
 * one nobody is looking at. The tool card's `approval-requested` display state
 * already exists for exactly this.
 */
export interface AcpRequestCardProps {
	entry: AcpRequestEntry;
	/**
	 * Answer a permission request. `label` is what the user actually clicked —
	 * the answered card shows it, and only the caller of the button knows it.
	 */
	onAnswerPermission: (
		requestId: string,
		optionId: string,
		label: string,
	) => void;
	/** Accept an elicitation with the form's own property names as keys. */
	onAcceptElicitation: (
		requestId: string,
		content: Record<string, string | string[]>,
		summary: string,
	) => void;
	/** Decline an elicitation — the agent is told, and gets no answer. */
	onDeclineElicitation: (requestId: string) => void;
}

const OUTCOME_STATE: Record<AcpRequestOutcome["kind"], ToolDisplayState> = {
	answered: "approval-responded",
	declined: "output-denied",
	unavailable: "output-error",
};

export const AcpRequestCard = memo(function AcpRequestCard({
	entry,
	onAnswerPermission,
	onAcceptElicitation,
	onDeclineElicitation,
}: AcpRequestCardProps) {
	const pending = entry.outcome === null;
	// Open while it waits: a question folded into a one-line header is a
	// question the user will not answer.
	const [open, setOpen] = useState(pending);
	const { request, outcome } = entry;

	return (
		<Tool className="mb-3" onOpenChange={setOpen} open={open}>
			<ToolHeader
				state={outcome ? OUTCOME_STATE[outcome.kind] : "approval-requested"}
				title={request.title}
			>
				<span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
					{request.kind === "permission"
						? (request.toolName ?? "permission")
						: "question"}
				</span>
			</ToolHeader>
			<ToolContent>
				<div className="space-y-2 p-2 text-xs">
					{outcome && <AcpRequestOutcomeLine outcome={outcome} />}
					{pending && request.kind === "permission" && (
						<AcpPermissionBody
							entry={entry}
							onAnswerPermission={onAnswerPermission}
						/>
					)}
					{pending && request.kind === "elicitation" && request.form && (
						<AcpElicitationBody
							entry={entry}
							onAcceptElicitation={onAcceptElicitation}
							onDeclineElicitation={onDeclineElicitation}
						/>
					)}
				</div>
			</ToolContent>
		</Tool>
	);
});

/** What happened, in the card, so an answered card still says what was chosen. */
function AcpRequestOutcomeLine({ outcome }: { outcome: AcpRequestOutcome }) {
	if (outcome.kind === "answered") {
		return (
			<div className="text-muted-foreground">
				Answered: <span className="text-foreground">{outcome.summary}</span>
			</div>
		);
	}
	if (outcome.kind === "declined") {
		return <div className="text-muted-foreground">Declined.</div>;
	}
	return <div className="text-destructive">{outcome.reason}</div>;
}

function AcpPermissionBody({
	entry,
	onAnswerPermission,
}: {
	entry: AcpRequestEntry;
	onAnswerPermission: (
		requestId: string,
		optionId: string,
		label: string,
	) => void;
}) {
	const options = entry.request.options ?? [];
	if (options.length === 0) {
		// The wire decides which options exist; a card with none is a request
		// nothing can answer, and saying so beats an empty row.
		return (
			<div className="text-muted-foreground">
				No options offered — this request cannot be answered here.
			</div>
		);
	}

	return (
		<div className="flex flex-wrap gap-1.5">
			{options.map((option) => (
				<Button
					className="h-6 px-2 text-xs"
					key={option.optionId}
					onClick={() =>
						onAnswerPermission(
							entry.request.requestId,
							option.optionId,
							option.name,
						)
					}
					size="sm"
					variant={
						option.kind === "reject_once" || option.kind === "reject_always"
							? "outline"
							: "default"
					}
				>
					{option.name}
				</Button>
			))}
		</div>
	);
}

function AcpElicitationBody({
	entry,
	onAcceptElicitation,
	onDeclineElicitation,
}: {
	entry: AcpRequestEntry;
	onAcceptElicitation: (
		requestId: string,
		content: Record<string, string | string[]>,
		summary: string,
	) => void;
	onDeclineElicitation: (requestId: string) => void;
}) {
	const form = entry.request.form;
	const [groups] = useState<AcpElicitationGroup[]>(() =>
		form ? groupElicitationFields(form) : [],
	);
	const [selections, setSelections] = useState<AcpElicitationSelections>({});

	const setValue = (key: string, value: string | string[]) =>
		setSelections((current) => ({ ...current, [key]: value }));

	const submit = () => {
		onAcceptElicitation(
			entry.request.requestId,
			buildElicitationContent(groups, selections),
			describeElicitationAnswer(groups, selections),
		);
	};

	/**
	 * A single-select with no free-text box beside it answers on the click —
	 * a second "Submit" press for a decision already made is friction the
	 * whole card exists to avoid. Anything else needs an explicit submit,
	 * because the user is not finished until they say so.
	 */
	const answersOnClick =
		groups.length === 1 &&
		groups[0]?.field.kind === "select" &&
		!groups[0]?.customField;

	return (
		<div className="space-y-3">
			{form?.title && <div className="text-foreground">{form.title}</div>}
			{groups.map((group) => (
				<div className="space-y-1.5" key={group.field.key}>
					<AcpFieldLabel field={group.field} />
					{group.field.kind === "select" && (
						<div className="flex flex-wrap gap-1.5">
							{(group.field.options ?? []).map((option) => (
								<Button
									className="h-6 px-2 text-xs"
									key={option.value}
									onClick={() => {
										setValue(group.field.key, option.value);
										if (answersOnClick) {
											onAcceptElicitation(
												entry.request.requestId,
												{ [group.field.key]: option.value },
												option.label,
											);
										}
									}}
									size="sm"
									title={option.description}
									variant={
										selections[group.field.key] === option.value
											? "default"
											: "outline"
									}
								>
									{option.label}
								</Button>
							))}
						</div>
					)}
					{group.field.kind === "multiselect" && (
						<div className="space-y-1">
							{(group.field.options ?? []).map((option) => {
								const current = selections[group.field.key];
								const chosen = Array.isArray(current) ? current : [];
								const checked = chosen.includes(option.value);
								// The request id scopes the control id: two cards in one
								// transcript can carry the same field key and option value.
								const id = `${entry.request.requestId}-${group.field.key}-${option.value}`;
								return (
									<label
										className="flex items-center gap-2 text-foreground"
										htmlFor={id}
										key={option.value}
									>
										<Checkbox
											checked={checked}
											id={id}
											onCheckedChange={(next) =>
												setValue(
													group.field.key,
													next === true
														? [...chosen, option.value]
														: chosen.filter((value) => value !== option.value),
												)
											}
										/>
										<span>{option.label}</span>
									</label>
								);
							})}
						</div>
					)}
					{group.field.kind === "text" && (
						<Input
							className="h-7 text-xs"
							onChange={(event) =>
								setValue(group.field.key, event.target.value)
							}
							placeholder={group.field.description ?? "Type an answer"}
							value={asInputValue(selections[group.field.key])}
						/>
					)}
					{group.customField && (
						<Input
							className="h-7 text-xs"
							onChange={(event) =>
								setValue(group.customField?.key ?? "", event.target.value)
							}
							placeholder={group.customField.title ?? "Or type your own answer"}
							value={asInputValue(selections[group.customField.key])}
						/>
					)}
				</div>
			))}
			<div className="flex items-center gap-1.5">
				{!answersOnClick && (
					<Button
						className="h-6 px-2 text-xs"
						disabled={!canSubmitElicitation(groups, selections)}
						onClick={submit}
						size="sm"
					>
						Submit
					</Button>
				)}
				{/* Subtle by design: declining is a real answer the agent handles,
				    but it is not the one the card is asking for. */}
				<Button
					className="h-6 px-2 text-muted-foreground text-xs"
					onClick={() => onDeclineElicitation(entry.request.requestId)}
					size="sm"
					variant="ghost"
				>
					Decline
				</Button>
			</div>
		</div>
	);
}

function AcpFieldLabel({ field }: { field: AcpElicitationField }) {
	if (!field.title && !field.description) return null;
	return (
		<div>
			{field.title && <div className="text-foreground">{field.title}</div>}
			{field.description && (
				<div className="text-muted-foreground">{field.description}</div>
			)}
		</div>
	);
}

/** A multiselect's array can never reach a text input; narrow rather than cast. */
function asInputValue(value: string | string[] | undefined): string {
	return typeof value === "string" ? value : "";
}

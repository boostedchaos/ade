import { Button } from "@superset/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@superset/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Spinner } from "@superset/ui/spinner";
import { Switch } from "@superset/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { type ReactElement, useMemo, useState } from "react";
import { HiCheck, HiChevronUpDown } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type AcpConfigOption,
	type AcpControlBarState,
	controlKind,
	emptyControlBar,
	switchValues,
	useAcpControlBarStore,
	visibleControls,
} from "./controlBar";

/** Stable identity, for the same reason `AcpPane`'s empty transcript is. */
const EMPTY_CONTROL_BAR: AcpControlBarState = emptyControlBar();

interface AcpControlBarProps {
	paneId: string;
	/** True while the session is not live; every control is inert. */
	disabled: boolean;
}

/**
 * Model / effort / fast / agent, rendered from whatever the adapter reports.
 *
 * The layout is not fixed at four controls: `effort` and `fast` appear and
 * vanish when the model changes, `agent` exists only where custom agents are
 * configured, and a missing control is normal rather than an error. Anything
 * the adapter adds in a future version renders as a plain select.
 *
 * No control ever displays the value the user picked. Each write is followed by
 * a wire read-back, and what lands here is what the read-back reported — which
 * for a model id the adapter could not place is a DIFFERENT model, silently
 * substituted. The warning chip is that substitution made visible.
 *
 * Three outcomes, and each looks different (A2/A4): the value landed, the
 * adapter applied something ELSE, or the read-back reported nothing and the
 * write is simply unproven. An alias the adapter merely canonicalized ("opus" →
 * "claude-opus-5") is not a substitution and gets no chip — a warning that
 * fires on correct writes is one nobody reads.
 */
export function AcpControlBar({ paneId, disabled }: AcpControlBarProps) {
	const state = useAcpControlBarStore(
		(store) => store.byPane[paneId] ?? EMPTY_CONTROL_BAR,
	);
	const started = useAcpControlBarStore((store) => store.started);
	const settled = useAcpControlBarStore((store) => store.settled);
	const failed = useAcpControlBarStore((store) => store.failed);

	const { mutate: setConfigOptionMutate } =
		electronTrpc.acp.setConfigOption.useMutation();

	const controls = useMemo(
		() => visibleControls(state.options),
		[state.options],
	);

	const write = (configId: string, value: string, allowUnlisted = false) => {
		started(paneId, configId);
		setConfigOptionMutate(
			{ paneId, configId, value, allowUnlisted },
			{
				onSuccess: (result) => settled(paneId, result),
				// VERBATIM: `acp-invalid-config-value` lists the legal values, and
				// `acp-session-*` names its own fix.
				onError: (error) => failed(paneId, error.message),
			},
		);
	};

	return (
		<div className="flex h-full min-w-0 items-center gap-1.5 px-2">
			<span className="shrink-0 text-muted-foreground text-xs">ACP</span>
			{controls.map((option) => (
				<div className="flex min-w-0 items-center gap-1.5" key={option.id}>
					{renderControl(option, state, disabled, (value, allowUnlisted) =>
						write(option.id, value, allowUnlisted),
					)}
					{state.mismatch?.configId === option.id && (
						<span className="shrink-0 rounded border border-[var(--argus-iris-waiting)]/40 bg-[var(--argus-iris-waiting)]/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
							{`adapter resolved '${state.mismatch.requestedValue}' → '${state.mismatch.actualValue ?? "unknown"}'`}
						</span>
					)}
					{state.unverified?.configId === option.id && (
						<span className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
							{`could not verify '${state.unverified.requestedValue}'`}
						</span>
					)}
				</div>
			))}
			{state.error && (
				<span className="min-w-0 truncate text-[10px] text-destructive">
					{state.error}
				</span>
			)}
		</div>
	);
}

type WriteFn = (value: string, allowUnlisted?: boolean) => void;

function renderControl(
	option: AcpConfigOption,
	state: AcpControlBarState,
	disabled: boolean,
	write: WriteFn,
): ReactElement {
	const busy = state.pending === option.id;
	const inert = disabled || state.pending !== null;

	switch (controlKind(option)) {
		case "model":
			return (
				<ModelControl
					busy={busy}
					disabled={inert}
					option={option}
					write={write}
				/>
			);
		case "switch":
			return (
				<SwitchControl
					busy={busy}
					disabled={inert}
					option={option}
					write={write}
				/>
			);
		default:
			return (
				<SelectControl
					busy={busy}
					disabled={inert}
					option={option}
					write={write}
				/>
			);
	}
}

interface ControlProps {
	option: AcpConfigOption;
	/** This control's own write is on the wire. */
	busy: boolean;
	disabled: boolean;
	write: WriteFn;
}

/** The adapter's `description` is the tooltip — it carries e.g. why fast mode is off. */
function withTooltip(
	option: AcpConfigOption,
	control: ReactElement,
): ReactElement {
	if (!option.description) return control;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{control}</TooltipTrigger>
			<TooltipContent>{option.description}</TooltipContent>
		</Tooltip>
	);
}

function labelFor(option: AcpConfigOption): string {
	const current = option.values?.find(
		(value) => value.id === option.currentValue,
	);
	// An unlisted current value is the interesting case, not a broken one: it is
	// what a typed model id looks like once the adapter accepted it.
	return current?.label ?? option.currentValue ?? option.name;
}

function SelectControl({ option, busy, disabled, write }: ControlProps) {
	return withTooltip(
		option,
		<div className="flex items-center gap-1">
			<Select
				disabled={disabled}
				onValueChange={(value) => write(value)}
				value={option.currentValue ?? ""}
			>
				<SelectTrigger
					className="h-6 gap-1 border-border/60 px-2 text-xs"
					size="sm"
				>
					<SelectValue placeholder={option.name} />
				</SelectTrigger>
				<SelectContent>
					{option.values?.map((value) => (
						<SelectItem className="text-xs" key={value.id} value={value.id}>
							{value.label ?? value.id}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{busy && <Spinner className="size-3 text-muted-foreground" />}
		</div>,
	);
}

function SwitchControl({ option, busy, disabled, write }: ControlProps) {
	const { on, off } = switchValues(option);
	return withTooltip(
		option,
		<div className="flex items-center gap-1.5">
			<span className="text-muted-foreground text-xs">{option.name}</span>
			<Switch
				checked={option.currentValue === on}
				disabled={disabled}
				onCheckedChange={(next) => write(next ? on : off)}
			/>
			{busy && <Spinner className="size-3 text-muted-foreground" />}
		</div>,
	);
}

/**
 * The model picker: the reported list PLUS anything the user types.
 *
 * The typed path exists because the adapter's list is not exhaustive — a model
 * it knows may simply not be in it. A typed id goes out with `allowUnlisted`,
 * which waives the host's local value gate for this one option only.
 */
function ModelControl({ option, busy, disabled, write }: ControlProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const values = option.values ?? [];
	const query = search.trim();
	const matches = query
		? values.filter(
				(value) =>
					value.id.toLowerCase().includes(query.toLowerCase()) ||
					(value.label ?? "").toLowerCase().includes(query.toLowerCase()),
			)
		: values;
	const unlisted =
		query.length > 0 && !values.some((value) => value.id === query);

	const submit = (value: string, allowUnlisted: boolean) => {
		write(value, allowUnlisted);
		setOpen(false);
		setSearch("");
	};

	return withTooltip(
		option,
		<Popover modal={false} onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<Button
					className="h-6 gap-1 border border-border/60 px-2 font-normal text-xs"
					disabled={disabled}
					variant="ghost"
				>
					<span className="max-w-[12rem] truncate">{labelFor(option)}</span>
					{busy ? (
						<Spinner className="size-3 text-muted-foreground" />
					) : (
						<HiChevronUpDown className="size-3 shrink-0 text-muted-foreground" />
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-64 p-0"
				onWheel={(event) => event.stopPropagation()}
			>
				<Command shouldFilter={false}>
					<CommandInput
						onValueChange={setSearch}
						placeholder="Model, or type an id…"
						value={search}
					/>
					<CommandList className="max-h-[240px]">
						<CommandEmpty>No matching model</CommandEmpty>
						{matches.map((value) => (
							<CommandItem
								className="text-xs"
								key={value.id}
								onSelect={() => submit(value.id, false)}
								value={value.id}
							>
								<span className="truncate">{value.label ?? value.id}</span>
								{option.currentValue === value.id && (
									<HiCheck className="ml-auto size-3.5 shrink-0 text-primary" />
								)}
							</CommandItem>
						))}
						{unlisted && (
							<CommandItem
								className="text-xs"
								onSelect={() => submit(query, true)}
								value={query}
							>
								<span className="truncate">{`Use "${query}"`}</span>
							</CommandItem>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>,
	);
}

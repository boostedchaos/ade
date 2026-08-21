/**
 * An elicitation form → the controls the question card draws, and the answer
 * those controls produce (B2).
 *
 * The host has already narrowed the wire's open JSON Schema to three field
 * kinds (`select` / `multiselect` / `text`, see `acp-host/elicitation.ts`).
 * What is left is a RENDERING decision the host deliberately does not make:
 * `AskUserQuestion` emits a `question_N` field and a `question_N_custom`
 * free-text field beside it, and those are ONE question — the custom box is
 * where the user types an answer instead of picking one. Drawing them as two
 * independent fields would ask the same question twice.
 *
 * Pure, so the pairing and the answer construction are testable without a
 * wire, a child or a React tree.
 */

import type { AcpElicitationField, AcpElicitationForm } from "./transcript";

/** The `_custom` suffix the adapter appends to a question's own key. */
const CUSTOM_SUFFIX = "_custom";

/**
 * One question: the control the user picks from, plus the optional free-text
 * box that belongs to it.
 */
export interface AcpElicitationGroup {
	field: AcpElicitationField;
	/** The `<key>_custom` text field, when the form carries one. */
	customField?: AcpElicitationField;
}

/**
 * Pair each field with its `_custom` sibling, in the form's own order.
 *
 * A `_custom` field is only ever consumed by the field it names. One that
 * matches nothing — a form the agent built differently — stays a question of
 * its own rather than being dropped: an omitted field reads to the agent as
 * "the user left it blank", which is a different answer from the one they gave.
 */
export function groupElicitationFields(
	form: AcpElicitationForm,
): AcpElicitationGroup[] {
	const byKey = new Map(form.fields.map((field) => [field.key, field]));
	const consumed = new Set<string>();

	for (const field of form.fields) {
		if (field.kind !== "text") continue;
		if (!field.key.endsWith(CUSTOM_SUFFIX)) continue;
		const ownerKey = field.key.slice(0, -CUSTOM_SUFFIX.length);
		const owner = byKey.get(ownerKey);
		// Only a select/multiselect owns a custom box. Two text fields named
		// `x` and `x_custom` are two questions.
		if (owner && owner.kind !== "text") consumed.add(field.key);
	}

	const groups: AcpElicitationGroup[] = [];
	for (const field of form.fields) {
		if (consumed.has(field.key)) continue;
		const custom = byKey.get(`${field.key}${CUSTOM_SUFFIX}`);
		groups.push({
			field,
			...(custom && consumed.has(custom.key) ? { customField: custom } : {}),
		});
	}
	return groups;
}

/**
 * What the user has entered so far, keyed by field key.
 *
 * `string` for a select or a text box, `string[]` for a multiselect — the same
 * two value types the answer accepts, so nothing is converted on the way out.
 */
export type AcpElicitationSelections = Record<string, string | string[]>;

/**
 * A group is answered when its own control has a value, OR when its custom box
 * does — the two are alternatives, which is why the custom box is never itself
 * required.
 */
export function isGroupAnswered(
	group: AcpElicitationGroup,
	selections: AcpElicitationSelections,
): boolean {
	if (hasValue(selections[group.field.key])) return true;
	if (group.customField && hasValue(selections[group.customField.key]))
		return true;
	return false;
}

/** Every REQUIRED group has an answer, so the form can be submitted. */
export function canSubmitElicitation(
	groups: AcpElicitationGroup[],
	selections: AcpElicitationSelections,
): boolean {
	return groups.every(
		(group) => !group.field.required || isGroupAnswered(group, selections),
	);
}

/**
 * The `accept` content, keyed by the schema's OWN property names.
 *
 * The agent reads its own keys back out of this, so a key is never renamed,
 * synthesized or dropped for tidiness. Empty values are omitted: sending
 * `""` for a box the user never touched claims they answered it with nothing.
 */
export function buildElicitationContent(
	groups: AcpElicitationGroup[],
	selections: AcpElicitationSelections,
): Record<string, string | string[]> {
	const content: Record<string, string | string[]> = {};
	for (const group of groups) {
		const own = selections[group.field.key];
		if (hasValue(own)) content[group.field.key] = own;
		if (!group.customField) continue;
		const custom = selections[group.customField.key];
		if (hasValue(custom)) content[group.customField.key] = custom;
	}
	return content;
}

/**
 * A one-line summary of what was sent, for the answered card to show.
 *
 * Labels, not raw values: the value is the agent's identifier and the label is
 * what the user actually clicked.
 */
export function describeElicitationAnswer(
	groups: AcpElicitationGroup[],
	selections: AcpElicitationSelections,
): string {
	const parts: string[] = [];
	for (const group of groups) {
		const chosen = labelsFor(group.field, selections[group.field.key]);
		const typed = group.customField
			? asText(selections[group.customField.key])
			: null;
		const answer = [...chosen, ...(typed ? [typed] : [])].join(", ");
		if (answer) parts.push(answer);
	}
	return parts.join(" · ");
}

function labelsFor(
	field: AcpElicitationField,
	value: string | string[] | undefined,
): string[] {
	const values = value === undefined ? [] : toArray(value).filter(Boolean);
	if (!field.options) return values;
	return values.map(
		(entry) =>
			field.options?.find((option) => option.value === entry)?.label ?? entry,
	);
}

function asText(value: string | string[] | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function toArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

function hasValue(value: string | string[] | undefined): boolean {
	if (value === undefined) return false;
	if (Array.isArray(value)) return value.length > 0;
	return value.trim() !== "";
}

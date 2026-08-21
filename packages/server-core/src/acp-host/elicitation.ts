/**
 * `elicitation/create` → a form the renderer can actually draw (A5).
 *
 * The protocol's form mode is an open JSON Schema: any property type, any
 * nesting a future ACP variant adds. This module narrows that to the shapes
 * the pane renders and REFUSES the rest, so an unsupported form produces a
 * `decline` on the wire rather than a card with missing controls or a request
 * that hangs.
 *
 * The shapes here are not a guess at what the agent might send. They are what
 * `claude-agent-acp` 0.63.0 builds for `AskUserQuestion` — the tool the whole
 * capability exists to re-enable (`elicitation.js:108-154`,
 * `askUserQuestionsToCreateRequest`): one `{type: "string", oneOf: EnumOption[]}`
 * per question for a single-select, `{type: "array", items: {anyOf:
 * EnumOption[]}}` for a multi-select, and a plain `{type: "string"}` "Other"
 * field beside each so the user can type their own answer instead.
 */

import type {
	CreateElicitationRequest,
	ElicitationPropertySchema,
	ElicitationSchema,
} from "@agentclientprotocol/sdk";

/** One option of a select/multi-select field. */
export interface AcpElicitationOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * A field the renderer knows how to draw.
 *
 * `key` is the schema's own property name and is what the answer is keyed by
 * on the way back — the agent reads its own keys out of the response
 * (`applyAskElicitationResponse`), so it must survive the round trip
 * untouched.
 */
export interface AcpElicitationField {
	key: string;
	kind: "select" | "multiselect" | "text";
	title?: string;
	description?: string;
	/** Present for `select` / `multiselect`, absent for `text`. */
	options?: AcpElicitationOption[];
	required: boolean;
}

export interface AcpElicitationForm {
	/** `requestedSchema.title`, when the agent supplied one. */
	title?: string;
	fields: AcpElicitationField[];
}

/**
 * The subset of `mode` values this client handles.
 *
 * Only `form` is advertised in `clientCapabilities.elicitation`, so `url`
 * should never arrive — but the agent decides what it sends, and a mode we
 * cannot render has to decline rather than fall through to an empty form.
 */
const SUPPORTED_MODE = "form";

/**
 * Every property variant ends in an open `{ type: string; [key: string]:
 * unknown }` member for future ACP types, so narrowing on `type` still leaves
 * that member in the union and every other field typed as `unknown`. Reading
 * through this view and checking each value at runtime is therefore not
 * defensive padding — it is the only thing the declared type actually permits,
 * and it is what a wire that can carry anything deserves.
 */
type PropertyView = { type?: unknown } & Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** `["a", "b"]` → untitled options. Null unless EVERY entry is a string. */
function optionsFromEnum(value: unknown): AcpElicitationOption[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const options: AcpElicitationOption[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		options.push({ value: entry, label: entry });
	}
	return options;
}

/** `EnumOption[]` → titled options. Null unless every entry is well-formed. */
function optionsFromOneOf(value: unknown): AcpElicitationOption[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const options: AcpElicitationOption[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return null;
		const record = entry as Record<string, unknown>;
		const constValue = record.const;
		if (typeof constValue !== "string") return null;
		const description = optionalString(record.description);
		options.push({
			value: constValue,
			// A titled option whose title is missing still renders — as its own
			// value, which is what the user would otherwise see nothing of.
			label: optionalString(record.title) ?? constValue,
			...(description ? { description } : {}),
		});
	}
	return options;
}

/**
 * One property → one field, or `null` for a shape the renderer cannot draw.
 *
 * `number`, `integer` and `boolean` are legal ACP properties and are refused
 * on purpose: `AskUserQuestion` never emits them, and a half-rendered form is
 * worse than a declined one because the agent cannot tell the difference
 * between an answer the user gave and a control that was never shown.
 */
function toField(
	key: string,
	schema: ElicitationPropertySchema,
	required: boolean,
): AcpElicitationField | null {
	const property = schema as PropertyView;
	const title = optionalString(property.title);
	const description = optionalString(property.description);
	const common = {
		key,
		required,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
	};

	if (property.type === "string") {
		const options =
			optionsFromOneOf(property.oneOf) ?? optionsFromEnum(property.enum);
		if (options) return { ...common, kind: "select", options };
		// A free-text field. `AskUserQuestion`'s per-question "Other" box is this
		// shape, and it is always optional — the user types in it INSTEAD of
		// picking an option, so requiring it would demand both.
		return { ...common, kind: "text" };
	}

	if (property.type === "array") {
		const items = property.items;
		if (!items || typeof items !== "object") return null;
		const record = items as Record<string, unknown>;
		const options =
			optionsFromOneOf(record.anyOf) ?? optionsFromEnum(record.enum);
		// An array of anything but a declared value set has no control to draw.
		if (!options) return null;
		return { ...common, kind: "multiselect", options };
	}

	return null;
}

function normalizeSchema(schema: ElicitationSchema): AcpElicitationForm | null {
	const properties = schema.properties;
	if (!properties) return null;

	const required = new Set(schema.required ?? []);
	const fields: AcpElicitationField[] = [];
	// Insertion order is the agent's field order (`question_0`, `question_0_custom`,
	// `question_1`, …), and it is the order the user should read them in.
	for (const [key, property] of Object.entries(properties)) {
		const field = toField(key, property, required.has(key));
		// One unrenderable field fails the WHOLE form. Dropping it silently would
		// return an answer that omits a field the agent asked for, which reads to
		// the agent as "the user left it blank".
		if (!field) return null;
		fields.push(field);
	}

	if (fields.length === 0) return null;
	return {
		...(schema.title ? { title: schema.title } : {}),
		fields,
	};
}

/**
 * The whole request → a renderable form, or `null` to decline it.
 *
 * Pure, so the mapping is testable without a wire, a child, or an adapter.
 */
export function normalizeElicitationRequest(
	request: CreateElicitationRequest,
): AcpElicitationForm | null {
	if (request.mode !== SUPPORTED_MODE) return null;
	const schema = (request as { requestedSchema?: ElicitationSchema })
		.requestedSchema;
	if (!schema) return null;
	return normalizeSchema(schema);
}

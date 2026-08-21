import type {
	SessionConfigOption,
	SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import { acpError } from "./errors";
import type { AcpConfigOption } from "./types";

/**
 * The one config option a caller may write a value the adapter never declared.
 *
 * The adapter's model list is not exhaustive and a typed id must stay
 * reachable; every other option keeps the gate. See
 * `AcpSession.setConfigOption`.
 */
export const MODEL_CONFIG_ID = "model";

const BOOLEAN_VALUES: AcpConfigOption["values"] = [
	{ id: "true", label: "On" },
	{ id: "false", label: "Off" },
];

/**
 * Flatten a select's values, including the grouped form.
 *
 * A group's name is folded into each label as `"Group / Option"` rather than
 * kept as structure: the control bar renders one flat list, and dropping the
 * group name entirely would leave two identically-named options from different
 * providers indistinguishable.
 */
function flattenSelectOptions(
	options: SessionConfigSelectOptions,
): NonNullable<AcpConfigOption["values"]> {
	const flat: NonNullable<AcpConfigOption["values"]> = [];
	for (const entry of options) {
		if ("group" in entry) {
			for (const option of entry.options) {
				flat.push({
					id: option.value,
					label: `${entry.name} / ${option.name}`,
					...(option.description ? { description: option.description } : {}),
				});
			}
		} else {
			flat.push({
				id: entry.value,
				label: entry.name,
				...(entry.description ? { description: entry.description } : {}),
			});
		}
	}
	return flat;
}

/** Normalize the adapter's config option into the host's flat shape. */
export function toAcpConfigOption(
	option: SessionConfigOption,
): AcpConfigOption {
	const common = {
		id: option.id,
		name: option.name,
		...(option.description ? { description: option.description } : {}),
		...(option.category ? { category: option.category } : {}),
	};

	if (option.type === "boolean") {
		return {
			...common,
			values: BOOLEAN_VALUES,
			currentValue: String(option.currentValue),
		};
	}

	return {
		...common,
		values: flattenSelectOptions(option.options),
		currentValue: option.currentValue,
	};
}

/**
 * Per-session cache of the adapter's config options, plus the local write gate.
 *
 * Phase 0 ground truth: an invalid `session/set_config_option` value is
 * ACCEPTED, returns success, and silently downgrades to `default`. A green
 * write means nothing, so the only real defense is refusing to send a value the
 * adapter never declared.
 *
 * The cache is seeded from `session/new`, reconciled by `config_option_update`
 * notifications, and re-seeded by `AcpSession.resume()` — `session/resume` is
 * the only verified on-demand read-back, and every write goes through one
 * (Phase 4, D3).
 */
export class ConfigOptionCache {
	private options = new Map<string, AcpConfigOption>();
	private booleanIds = new Set<string>();

	/** Replace the whole cache from an adapter-supplied option list. */
	replaceAll(options: readonly SessionConfigOption[] | null | undefined): void {
		this.options.clear();
		this.booleanIds.clear();
		for (const option of options ?? []) {
			this.options.set(option.id, toAcpConfigOption(option));
			if (option.type === "boolean") {
				this.booleanIds.add(option.id);
			}
		}
	}

	list(): AcpConfigOption[] {
		return Array.from(this.options.values(), (option) => ({
			...option,
			values: option.values ? [...option.values] : undefined,
		}));
	}

	get(optionId: string): AcpConfigOption | undefined {
		return this.options.get(optionId);
	}

	/** True when the adapter declared this option as a boolean. */
	isBoolean(optionId: string): boolean {
		return this.booleanIds.has(optionId);
	}

	/**
	 * Gate a write. Throws `acp-invalid-config-value` for an unknown option id
	 * or a value outside the declared list; nothing is sent in that case.
	 *
	 * An option with no declared values is free-form and passes through.
	 */
	assertValid(optionId: string, value: string): void {
		const option = this.options.get(optionId);
		if (!option) {
			const known = Array.from(this.options.keys()).join(", ") || "(none)";
			throw acpError(
				"acp-invalid-config-value",
				`unknown config option "${optionId}". Known options: ${known}`,
			);
		}

		const values = option.values;
		if (!values || values.length === 0) return;

		if (!values.some((entry) => entry.id === value)) {
			const legal = values.map((entry) => entry.id).join(", ");
			throw acpError(
				"acp-invalid-config-value",
				`"${value}" is not a declared value for "${optionId}". Legal values: ${legal}`,
			);
		}
	}

	/** Optimistic update after a write we have already validated and sent. */
	applyLocalWrite(optionId: string, value: string): void {
		const option = this.options.get(optionId);
		if (!option) return;
		this.options.set(optionId, { ...option, currentValue: value });
	}
}

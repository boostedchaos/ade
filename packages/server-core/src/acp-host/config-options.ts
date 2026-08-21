import type {
	SessionConfigOption,
	SessionConfigSelectOption,
	SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import { acpError } from "./errors";
import type { AcpConfigOption } from "./types";

const BOOLEAN_VALUES: { id: string; label?: string }[] = [
	{ id: "true", label: "On" },
	{ id: "false", label: "Off" },
];

function flattenSelectOptions(
	options: SessionConfigSelectOptions,
): SessionConfigSelectOption[] {
	const flat: SessionConfigSelectOption[] = [];
	for (const entry of options) {
		if ("group" in entry) {
			flat.push(...entry.options);
		} else {
			flat.push(entry);
		}
	}
	return flat;
}

/** Normalize the adapter's config option into the host's flat shape. */
export function toAcpConfigOption(
	option: SessionConfigOption,
): AcpConfigOption {
	if (option.type === "boolean") {
		return {
			id: option.id,
			values: BOOLEAN_VALUES,
			currentValue: String(option.currentValue),
		};
	}

	return {
		id: option.id,
		values: flattenSelectOptions(option.options).map((entry) => ({
			id: entry.value,
			label: entry.name,
		})),
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
 * The cache is seeded from `session/new` and reconciled by
 * `config_option_update` notifications. `session/resume` is the only verified
 * on-demand read-back and Phase 1 never resumes mid-session; a future resume
 * path MUST re-seed this cache from the `session/resume` response.
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

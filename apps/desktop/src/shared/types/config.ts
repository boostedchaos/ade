export interface SetupConfig {
	setup?: string[];
	teardown?: string[];
	// Windows-specific overrides. macOS-authored setup commands (./setup.sh,
	// chmod, ...) fail under any Windows shell, so a config can provide
	// Windows-native equivalents; on win32 these replace setup/teardown when
	// present (selected once in loadSetupConfig's readConfigFile).
	"setup.win"?: string[];
	"teardown.win"?: string[];
}

export interface SetupAction {
	id: string;
	category:
		| "package-manager"
		| "environment"
		| "infrastructure"
		| "version-manager";
	label: string;
	detail: string;
	command: string;
	enabled: boolean;
}

export interface SetupDetectionResult {
	projectSummary: string;
	actions: SetupAction[];
	setupTemplate: string[];
	signals: Record<string, boolean>;
}

import type { BrowserWindow } from "electron";
import { router } from "..";
import { createAuthRouter } from "./auth";
import { createAutoUpdateRouter } from "./auto-update";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserHistoryRouter } from "./browser-history";
import { createCacheRouter } from "./cache";
import { createChangesRouter } from "./changes";
import { createClaudeSessionsRouter } from "./claude-sessions";
import { createConfigRouter } from "./config";
import { createExternalRouter } from "./external";
import { createFilesystemRouter } from "./filesystem";
import { createGithubRouter } from "./github";
import { createHotkeysRouter } from "./hotkeys";
import { createMailRouter } from "./mail";
import { createMenuRouter } from "./menu";
import { createNotificationsRouter } from "./notifications";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectsRouter } from "./projects";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createRingtoneRouter } from "./ringtone";
import { createSettingsRouter } from "./settings";
import { createSyncRouter } from "./sync";
import { createTeamDashboardRouter } from "./team-dashboard";
import { createTerminalRouter } from "./terminal";
import { createUiStateRouter } from "./ui-state";
import { createUsageRouter } from "./usage";
import { createWindowRouter } from "./window";
import { createWorkspacesRouter } from "./workspaces";

export const createAppRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		browser: createBrowserRouter(),
		browserHistory: createBrowserHistoryRouter(),
		auth: createAuthRouter(),
		autoUpdate: createAutoUpdateRouter(),
		cache: createCacheRouter(),
		window: createWindowRouter(getWindow),
		projects: createProjectsRouter(getWindow),
		workspaces: createWorkspacesRouter(),
		teamDashboard: createTeamDashboardRouter(),
		terminal: createTerminalRouter(),
		changes: createChangesRouter(),
		claudeSessions: createClaudeSessionsRouter(),
		filesystem: createFilesystemRouter(),
		github: createGithubRouter(),
		mail: createMailRouter(),
		notifications: createNotificationsRouter(),
		permissions: createPermissionsRouter(),
		ports: createPortsRouter(),
		resourceMetrics: createResourceMetricsRouter(),
		usage: createUsageRouter(),
		menu: createMenuRouter(),
		hotkeys: createHotkeysRouter(getWindow),
		external: createExternalRouter(),
		settings: createSettingsRouter(),
		config: createConfigRouter(),
		uiState: createUiStateRouter(),
		sync: createSyncRouter(),
		ringtone: createRingtoneRouter(getWindow),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;

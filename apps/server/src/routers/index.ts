import { router } from "../trpc";
import { changesRouter } from "./changes";
import { claudeSessionsRouter } from "./claude-sessions";
import { configRouter } from "./config";
import { externalRouter } from "./external";
import { filesystemRouter } from "./filesystem";
import { githubRouter } from "./github";
import { healthRouter } from "./health";
import { mailRouter } from "./mail";
import { notificationsRouter } from "./notifications";
import { projectsRouter } from "./projects";
import { resourceMetricsRouter } from "./resource-metrics";
import { settingsRouter, syncRouter } from "./stubs";
import { teamDashboardRouter } from "./team-dashboard";
import { terminalRouter } from "./terminal";
import { uiStateRouter } from "./ui-state";
import { usageRouter } from "./usage";
import { workspacesRouter } from "./workspaces";

/**
 * The server router. Phase 1 extraction lands the desktop's core routers here
 * (workspaces, projects, terminal, filesystem, changes, config, settings,
 * ports, sync, cache, utils, resource-metrics, browser-history, ui-state) as
 * they move into packages/server-core — see planning/PHASE_1.md §3.
 */
export const appRouter = router({
	projects: projectsRouter,
	settings: settingsRouter,
	sync: syncRouter,
	workspaces: workspacesRouter,
	teamDashboard: teamDashboardRouter,
	filesystem: filesystemRouter,
	github: githubRouter,
	health: healthRouter,
	mail: mailRouter,
	notifications: notificationsRouter,
	terminal: terminalRouter,
	uiState: uiStateRouter,
	changes: changesRouter,
	resourceMetrics: resourceMetricsRouter,
	usage: usageRouter,
	config: configRouter,
	external: externalRouter,
	claudeSessions: claudeSessionsRouter,
});

export type AppRouter = typeof appRouter;

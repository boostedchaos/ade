import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_SCAFFOLD_ENABLED } from "@ade/server-core/feature-flags";
import { localDb } from "@ade/server-core/local-db";
import { projects } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/**
 * Config router — server mirror of the desktop `config` paths the renderer
 * reads at boot and on the project settings pages. `featureFlags` gates the
 * Agent Files panel (RightSidebar shows the tab only when memoryScaffold is
 * on). The config-file procedures back Settings → Project → General, whose
 * route loader calls `getConfigFilePath` before rendering — without them the
 * loader throws and takes the router down on web. Other config procedures
 * (runtimeAvailability, setup-card flows) remain desktop-only until their
 * surfaces are needed on web.
 */

const CONFIG_TEMPLATE = `{
  "setup": [],
  "teardown": []
}
`;

function getConfigPath(mainRepoPath: string): string {
	return join(mainRepoPath, ".superset", "config.json");
}

function ensureConfigExists(mainRepoPath: string): string {
	const configPath = getConfigPath(mainRepoPath);
	const supersetDir = join(mainRepoPath, ".superset");

	if (!existsSync(configPath)) {
		if (!existsSync(supersetDir)) {
			mkdirSync(supersetDir, { recursive: true });
		}
		writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
	}

	return configPath;
}

function getProject(projectId: string) {
	return localDb
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
}

export const configRouter = router({
	featureFlags: authedProcedure.query(() => ({
		memoryScaffold: MEMORY_SCAFFOLD_ENABLED,
	})),

	// Get the config file path (creates it if it doesn't exist). ADE
	// categories have an empty mainRepoPath — without the guard,
	// ensureConfigExists("") writes .superset/ relative to the server's CWD.
	getConfigFilePath: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => {
			const project = getProject(input.projectId);
			if (!project?.mainRepoPath) {
				return null;
			}
			return ensureConfigExists(project.mainRepoPath);
		}),

	// Get the config file content
	getConfigContent: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => {
			const project = getProject(input.projectId);
			if (!project?.mainRepoPath) {
				return { content: null, exists: false };
			}

			const configPath = getConfigPath(project.mainRepoPath);
			if (!existsSync(configPath)) {
				return { content: null, exists: false };
			}

			try {
				const content = readFileSync(configPath, "utf-8");
				return { content, exists: true };
			} catch {
				return { content: null, exists: false };
			}
		}),

	// Update the config file with new setup/teardown scripts
	updateConfig: authedProcedure
		.input(
			z.object({
				projectId: z.string(),
				setup: z.array(z.string()),
				teardown: z.array(z.string()),
			}),
		)
		.mutation(({ input }) => {
			const project = getProject(input.projectId);
			if (!project?.mainRepoPath) {
				throw new Error("Project not found");
			}

			const configPath = ensureConfigExists(project.mainRepoPath);

			// Read and parse existing config, preserving other fields
			let existingConfig: Record<string, unknown> = {};
			try {
				const existingContent = readFileSync(configPath, "utf-8");
				const parsed = JSON.parse(existingContent);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					existingConfig = parsed;
				}
			} catch {
				existingConfig = {};
			}

			const config = {
				...existingConfig,
				setup: input.setup,
				teardown: input.teardown,
			};

			try {
				writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
				return { success: true };
			} catch (error) {
				console.error("[config/updateConfig] Failed to write config:", error);
				throw new Error("Failed to save config");
			}
		}),
});

/**
 * Per-agent resource metrics for ade-server.
 *
 * Headless port of the desktop's main/lib/resource-metrics. The desktop version
 * enumerated terminal sessions via the WorkspaceRuntime registry and added
 * Electron's `app.getAppMetrics()` for the app's own main/renderer CPU/memory.
 * Server-side there is no Electron: sessions come from the daemon terminal
 * manager, and the "app" figure is measured honestly as the server process's
 * own process tree (there is no separate renderer process — the renderer runs
 * in the user's browser, off-box). The per-session/per-workspace aggregation is
 * otherwise identical, so the web ResourceConsumption panel renders unchanged.
 */

import { workspaces } from "@superset/local-db";
import { eq } from "drizzle-orm";
import pidusage from "pidusage";
import { localDb } from "./local-db";
import { getDaemonTerminalManager } from "./terminal";
import { getProcessTree } from "./terminal/port-scanner";

interface ProcessMetrics {
	cpu: number;
	memory: number;
}

interface SessionMetrics {
	sessionId: string;
	paneId: string;
	pid: number;
	cpu: number;
	memory: number;
}

interface WorkspaceMetrics {
	workspaceId: string;
	workspaceName: string;
	cpu: number;
	memory: number;
	sessions: SessionMetrics[];
}

interface AppMetrics extends ProcessMetrics {
	main: ProcessMetrics;
	renderer: ProcessMetrics;
}

export interface ResourceMetricsSnapshot {
	app: AppMetrics;
	workspaces: WorkspaceMetrics[];
	totalCpu: number;
	totalMemory: number;
}

/** Measure the server's own process tree (stands in for Electron app metrics). */
async function collectServerAppMetrics(): Promise<AppMetrics> {
	const main: ProcessMetrics = { cpu: 0, memory: 0 };
	try {
		const treePids = await getProcessTree(process.pid);
		const pids = treePids.length > 0 ? treePids : [process.pid];
		const stats = await pidusage(pids);
		for (const pid of Object.keys(stats)) {
			const s = stats[Number(pid)];
			if (s) {
				main.cpu += s.cpu;
				main.memory += s.memory;
			}
		}
	} catch {
		// Process may have exited between listing and querying — report zeros.
	}
	// No separate renderer process on the server; the browser renderer is off-box.
	const renderer: ProcessMetrics = { cpu: 0, memory: 0 };
	return {
		cpu: main.cpu + renderer.cpu,
		memory: main.memory + renderer.memory,
		main,
		renderer,
	};
}

export async function collectResourceMetrics(): Promise<ResourceMetricsSnapshot> {
	const { sessions } = await getDaemonTerminalManager().listDaemonSessions();

	const workspaceSessionMap = new Map<
		string,
		Array<{ sessionId: string; paneId: string; pid: number }>
	>();
	for (const session of sessions) {
		if (!session.isAlive || session.pid == null) continue;
		let entries = workspaceSessionMap.get(session.workspaceId);
		if (!entries) {
			entries = [];
			workspaceSessionMap.set(session.workspaceId, entries);
		}
		entries.push({
			sessionId: session.sessionId,
			paneId: session.paneId,
			pid: session.pid,
		});
	}

	const allEntries = [...workspaceSessionMap.values()].flat();
	const sessionPidTrees = await Promise.all(
		allEntries.map(async (entry) => ({
			entry,
			treePids: await getProcessTree(entry.pid),
		})),
	);

	const allPids = sessionPidTrees.flatMap((s) =>
		s.treePids.length > 0 ? s.treePids : [s.entry.pid],
	);
	let pidStats: Record<number, pidusage.Status> = {};
	if (allPids.length > 0) {
		try {
			pidStats = await pidusage(allPids);
		} catch {
			// PIDs may have exited between listing and querying.
		}
	}

	const app = await collectServerAppMetrics();

	const sessionAggregated = new Map<string, { cpu: number; memory: number }>();
	for (const { entry, treePids } of sessionPidTrees) {
		let cpu = 0;
		let memory = 0;
		const pids = treePids.length > 0 ? treePids : [entry.pid];
		for (const pid of pids) {
			const stats = pidStats[pid];
			if (stats) {
				cpu += stats.cpu;
				memory += stats.memory;
			}
		}
		sessionAggregated.set(entry.sessionId, { cpu, memory });
	}

	const workspaceMetricsList: WorkspaceMetrics[] = [];
	const nameCache = new Map<string, string>();

	for (const [workspaceId, entries] of workspaceSessionMap) {
		if (!nameCache.has(workspaceId)) {
			const ws = localDb
				.select({ name: workspaces.name })
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.get();
			nameCache.set(workspaceId, ws?.name ?? "Unknown");
		}

		const sessionMetrics: SessionMetrics[] = [];
		let wsCpu = 0;
		let wsMemory = 0;
		for (const entry of entries) {
			const agg = sessionAggregated.get(entry.sessionId) ?? {
				cpu: 0,
				memory: 0,
			};
			sessionMetrics.push({
				sessionId: entry.sessionId,
				paneId: entry.paneId,
				pid: entry.pid,
				cpu: agg.cpu,
				memory: agg.memory,
			});
			wsCpu += agg.cpu;
			wsMemory += agg.memory;
		}

		workspaceMetricsList.push({
			workspaceId,
			workspaceName: nameCache.get(workspaceId) ?? "Unknown",
			cpu: wsCpu,
			memory: wsMemory,
			sessions: sessionMetrics,
		});
	}

	const sessionCpuTotal = workspaceMetricsList.reduce(
		(sum, ws) => sum + ws.cpu,
		0,
	);
	const sessionMemoryTotal = workspaceMetricsList.reduce(
		(sum, ws) => sum + ws.memory,
		0,
	);

	return {
		app,
		workspaces: workspaceMetricsList,
		totalCpu: app.cpu + sessionCpuTotal,
		totalMemory: app.memory + sessionMemoryTotal,
	};
}

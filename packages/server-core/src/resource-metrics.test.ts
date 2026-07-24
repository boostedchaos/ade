import { beforeAll, describe, expect, it, mock } from "bun:test";

// Synthetic session + process data. Two sessions belong to agent "ws-1", one to
// "ws-2"; each pid maps to a small process tree with known cpu/memory so the
// per-session and per-workspace aggregation is deterministic.
const SESSIONS = [
	{
		sessionId: "s1",
		workspaceId: "ws-1",
		paneId: "p1",
		isAlive: true,
		attachedClients: 1,
		pid: 100,
	},
	{
		sessionId: "s2",
		workspaceId: "ws-1",
		paneId: "p2",
		isAlive: true,
		attachedClients: 1,
		pid: 200,
	},
	{
		sessionId: "s3",
		workspaceId: "ws-2",
		paneId: "p3",
		isAlive: true,
		attachedClients: 0,
		pid: 300,
	},
	// Dead / pid-less sessions must be ignored.
	{
		sessionId: "s4",
		workspaceId: "ws-2",
		paneId: "p4",
		isAlive: false,
		attachedClients: 0,
		pid: 400,
	},
	{
		sessionId: "s5",
		workspaceId: "ws-2",
		paneId: "p5",
		isAlive: true,
		attachedClients: 0,
		pid: null,
	},
];

const PROCESS_TREES: Record<number, number[]> = {
	100: [100, 101],
	200: [200],
	300: [300, 301, 302],
	// server process tree (collectServerAppMetrics uses process.pid)
};

const PID_STATS: Record<number, { cpu: number; memory: number }> = {
	100: { cpu: 5, memory: 1000 },
	101: { cpu: 2, memory: 500 },
	200: { cpu: 10, memory: 2000 },
	300: { cpu: 1, memory: 100 },
	301: { cpu: 1, memory: 100 },
	302: { cpu: 1, memory: 100 },
};

let collectResourceMetrics: typeof import("./resource-metrics").collectResourceMetrics;

beforeAll(async () => {
	const realTerminal = await import("./terminal");
	mock.module("./terminal", () => ({
		...realTerminal,
		getDaemonTerminalManager: () => ({
			listDaemonSessions: async () => ({ sessions: SESSIONS }),
		}),
	}));

	// Spread the real module so other exports (getListeningPortsForPids, etc.)
	// remain linkable — bun's mock.module replaces the whole module globally, so
	// a partial mock would break unrelated files that import those names.
	const realPortScanner = await import("./terminal/port-scanner");
	mock.module("./terminal/port-scanner", () => ({
		...realPortScanner,
		getProcessTree: async (pid: number) => PROCESS_TREES[pid] ?? [],
	}));

	mock.module("pidusage", () => ({
		default: async (pids: number | number[]) => {
			const list = Array.isArray(pids) ? pids : [pids];
			const out: Record<number, { cpu: number; memory: number }> = {};
			for (const pid of list) {
				out[pid] = PID_STATS[pid] ?? { cpu: 0, memory: 0 };
			}
			return out;
		},
	}));

	mock.module("./local-db", () => ({
		localDb: {
			select: () => ({
				from: () => ({
					where: () => ({
						get: () => ({ name: "AgentName" }),
					}),
				}),
			}),
		},
	}));

	collectResourceMetrics = (await import("./resource-metrics"))
		.collectResourceMetrics;
});

describe("collectResourceMetrics", () => {
	it("aggregates per-session and per-workspace metrics from live sessions", async () => {
		const snapshot = await collectResourceMetrics();

		// Only the three alive, pid-bearing sessions across two workspaces.
		expect(snapshot.workspaces).toHaveLength(2);

		const ws1 = snapshot.workspaces.find((w) => w.workspaceId === "ws-1");
		const ws2 = snapshot.workspaces.find((w) => w.workspaceId === "ws-2");
		expect(ws1).toBeDefined();
		expect(ws2).toBeDefined();
		if (!ws1 || !ws2) return;

		expect(ws1.workspaceName).toBe("AgentName");
		expect(ws1.sessions).toHaveLength(2);

		// s1 = pids 100+101 = cpu 7, mem 1500; s2 = pid 200 = cpu 10, mem 2000.
		const s1 = ws1.sessions.find((s) => s.sessionId === "s1");
		const s2 = ws1.sessions.find((s) => s.sessionId === "s2");
		expect(s1?.cpu).toBe(7);
		expect(s1?.memory).toBe(1500);
		expect(s2?.cpu).toBe(10);
		expect(s2?.memory).toBe(2000);
		expect(ws1.cpu).toBe(17);
		expect(ws1.memory).toBe(3500);

		// ws-2: only s3 (pids 300/301/302 = cpu 3, mem 300). s4 dead, s5 no pid.
		expect(ws2.sessions).toHaveLength(1);
		expect(ws2.cpu).toBe(3);
		expect(ws2.memory).toBe(300);

		// Totals fold in the app process figure (>= session totals).
		expect(snapshot.totalCpu).toBeGreaterThanOrEqual(20);
		expect(snapshot.totalMemory).toBeGreaterThanOrEqual(3800);
		expect(snapshot.app).toBeDefined();
		expect(snapshot.app.renderer).toEqual({ cpu: 0, memory: 0 });
	});
});

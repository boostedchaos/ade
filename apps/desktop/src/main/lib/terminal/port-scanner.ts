import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import pidtree from "pidtree";

const execAsync = promisify(exec);

/** Timeout for shell commands to prevent hanging (ms) */
const EXEC_TIMEOUT_MS = 5000;

export interface PortInfo {
	port: number;
	pid: number;
	address: string;
	processName: string;
}

/**
 * Get all child PIDs of a process (including the process itself)
 */
export async function getProcessTree(pid: number): Promise<number[]> {
	try {
		return await pidtree(pid, { root: true });
	} catch {
		// Process may have exited
		return [];
	}
}

/**
 * Get listening TCP ports for a set of PIDs
 * Cross-platform implementation using lsof (macOS/Linux) or netstat (Windows)
 */
export async function getListeningPortsForPids(
	pids: number[],
): Promise<PortInfo[]> {
	if (pids.length === 0) return [];

	const platform = os.platform();

	if (platform === "darwin" || platform === "linux") {
		return getListeningPortsLsof(pids);
	}
	if (platform === "win32") {
		return getListeningPortsWindows(pids);
	}

	return [];
}

/**
 * macOS/Linux implementation using lsof
 */
async function getListeningPortsLsof(pids: number[]): Promise<PortInfo[]> {
	try {
		const pidArg = pids.join(",");
		const pidSet = new Set(pids);
		// -p: filter by PIDs
		// -iTCP: only TCP connections
		// -sTCP:LISTEN: only listening sockets
		// -P: don't convert port numbers to names
		// -n: don't resolve hostnames
		// Note: lsof may ignore -p filter if PIDs don't exist or have no matches,
		// so we must validate PIDs in the output against our requested set
		const { stdout: output } = await execAsync(
			`lsof -p ${pidArg} -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true`,
			{ maxBuffer: 10 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS },
		);

		if (!output.trim()) return [];

		const ports: PortInfo[] = [];
		const lines = output.trim().split("\n").slice(1);

		for (const line of lines) {
			if (!line.trim()) continue;

			// Format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
			// Example: node 12345 user 23u IPv4 0x1234 0t0 TCP *:3000 (LISTEN)
			const columns = line.split(/\s+/);
			if (columns.length < 10) continue;

			const processName = columns[0];
			const pid = Number.parseInt(columns[1], 10);

			// CRITICAL: Verify the PID is in our requested set
			// lsof ignores -p filter when PIDs don't exist, returning all TCP listeners
			if (!pidSet.has(pid)) continue;

			const name = columns[columns.length - 2]; // NAME column (e.g., *:3000), before (LISTEN)

			// Parse address:port from NAME column
			// Formats: *:3000, 127.0.0.1:3000, [::1]:3000, [::]:3000
			const match = name.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
			if (match) {
				const address = match[1] || match[2] || "*";
				const port = Number.parseInt(match[3], 10);

				if (port < 1 || port > 65535) continue;

				ports.push({
					port,
					pid,
					address: address === "*" ? "0.0.0.0" : address,
					processName,
				});
			}
		}

		return ports;
	} catch {
		return [];
	}
}

/**
 * Windows implementation using netstat
 */
async function getListeningPortsWindows(pids: number[]): Promise<PortInfo[]> {
	try {
		const { stdout: output } = await execAsync("netstat -ano", {
			maxBuffer: 10 * 1024 * 1024,
			timeout: EXEC_TIMEOUT_MS,
		});

		const pidSet = new Set(pids);
		const ports: PortInfo[] = [];
		const processNames = new Map<number, string>();

		// Collect unique PIDs that we need to look up names for
		const pidsToLookup: number[] = [];

		for (const line of output.split("\n")) {
			if (!line.includes("LISTENING")) continue;

			// Format: TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 12345
			const columns = line.trim().split(/\s+/);
			if (columns.length < 5) continue;

			const pid = Number.parseInt(columns[columns.length - 1], 10);
			if (!pidSet.has(pid)) continue;

			if (!processNames.has(pid) && !pidsToLookup.includes(pid)) {
				pidsToLookup.push(pid);
			}
		}

		// Resolve every name in a SINGLE batched CIM query (cache-aware) instead
		// of one PowerShell spawn per PID.
		const nameMap = await resolveProcessNamesWindows(pidsToLookup);
		for (const [pid, name] of nameMap) {
			processNames.set(pid, name);
		}

		// Now build the ports array
		for (const line of output.split("\n")) {
			if (!line.includes("LISTENING")) continue;

			const columns = line.trim().split(/\s+/);
			if (columns.length < 5) continue;

			const pid = Number.parseInt(columns[columns.length - 1], 10);
			if (!pidSet.has(pid)) continue;

			const localAddr = columns[1];
			// Parse address:port - handles both IPv4 and IPv6
			// IPv4: 0.0.0.0:3000
			// IPv6: [::]:3000
			const match = localAddr.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
			if (match) {
				const address = match[1] || match[2] || "0.0.0.0";
				const port = Number.parseInt(match[3], 10);

				if (port < 1 || port > 65535) continue;

				ports.push({
					port,
					pid,
					address,
					processName: processNames.get(pid) || "unknown",
				});
			}
		}

		return ports;
	} catch {
		return [];
	}
}

/**
 * Short-lived PID→name cache. A process's name never changes for the life of the
 * PID, so a brief TTL collapses the repeated lookups a periodic scan (every
 * 2.5s) would otherwise make, while still tolerating eventual PID reuse.
 */
const NAME_CACHE_TTL_MS = 30_000;
const nameCache = new Map<number, { name: string; ts: number }>();

function cleanProcessName(raw: string): string {
	return raw.trim().replace(/\.exe$/i, "") || "unknown";
}

/**
 * Parse the CSV emitted by `... | Select-Object ProcessId,Name | ConvertTo-Csv`.
 * Rows look like `"1234","node.exe"`; the header and any missing PIDs are simply
 * absent from the result. Exported for unit testing.
 */
export function parseProcessNameCsv(csv: string): Map<number, string> {
	const names = new Map<number, string>();
	for (const line of csv.split(/\r?\n/)) {
		const match = line.match(/^"(\d+)","(.*)"$/);
		if (!match) continue; // header, blank lines
		names.set(Number.parseInt(match[1], 10), cleanProcessName(match[2]));
	}
	return names;
}

/** Legacy per-PID wmic lookup (Windows versions before 24H2 removed wmic). */
async function getProcessNameWmic(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execAsync(
			`wmic process where processid=${pid} get name 2>nul`,
			{ timeout: EXEC_TIMEOUT_MS },
		);
		const lines = stdout.trim().split("\n");
		if (lines.length >= 2) return cleanProcessName(lines[1]);
	} catch {
		// ignore
	}
	return null;
}

/**
 * Resolve names for many PIDs in ONE PowerShell/CIM spawn instead of one spawn
 * per PID. Falls back to per-PID wmic only when CIM is unavailable/blocked.
 */
async function queryProcessNamesWindows(
	pids: number[],
): Promise<Map<number, string>> {
	if (pids.length === 0) return new Map();

	// ponytail: WQL has no IN(), so OR-chain the ids. Process trees are tens of
	// PIDs — far under the Windows command-line length limit. Revisit only if a
	// single scan ever needs to resolve hundreds of PIDs at once.
	const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
	try {
		const { stdout } = await execAsync(
			`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,Name | ConvertTo-Csv -NoTypeInformation"`,
			{ maxBuffer: 10 * 1024 * 1024, timeout: EXEC_TIMEOUT_MS },
		);
		return parseProcessNameCsv(stdout);
	} catch {
		// CIM unavailable/blocked; fall back to per-PID wmic (legacy systems).
		const names = new Map<number, string>();
		await Promise.all(
			pids.map(async (pid) => {
				const name = await getProcessNameWmic(pid);
				if (name) names.set(pid, name);
			}),
		);
		return names;
	}
}

/**
 * Cache-aware batched resolver: returns a name for every requested PID, querying
 * only the ones whose cached name is missing or stale.
 */
async function resolveProcessNamesWindows(
	pids: number[],
): Promise<Map<number, string>> {
	const now = Date.now();

	// Opportunistically drop expired entries so a long session with many
	// short-lived dev-server PIDs can't grow the cache without bound.
	if (nameCache.size > 256) {
		for (const [pid, entry] of nameCache) {
			if (now - entry.ts >= NAME_CACHE_TTL_MS) nameCache.delete(pid);
		}
	}

	const result = new Map<number, string>();
	const missing: number[] = [];
	for (const pid of pids) {
		const cached = nameCache.get(pid);
		if (cached && now - cached.ts < NAME_CACHE_TTL_MS) {
			result.set(pid, cached.name);
		} else {
			missing.push(pid);
		}
	}

	if (missing.length > 0) {
		const queried = await queryProcessNamesWindows(missing);
		for (const pid of missing) {
			const name = queried.get(pid) ?? "unknown";
			nameCache.set(pid, { name, ts: now });
			result.set(pid, name);
		}
	}

	return result;
}

/**
 * Get process name for a single PID on Windows. Delegates to the batched,
 * cache-aware resolver so single- and multi-PID callers share one query + cache.
 */
async function getProcessNameWindows(pid: number): Promise<string> {
	const names = await resolveProcessNamesWindows([pid]);
	return names.get(pid) ?? "unknown";
}

/**
 * Get process name for a PID (cross-platform)
 */
export async function getProcessName(pid: number): Promise<string> {
	const platform = os.platform();

	if (platform === "win32") {
		return getProcessNameWindows(pid);
	}

	// macOS/Linux
	try {
		const { stdout: output } = await execAsync(
			`ps -p ${pid} -o comm= 2>/dev/null || true`,
			{ timeout: EXEC_TIMEOUT_MS },
		);
		const name = output.trim();
		// On macOS, comm may be truncated. The full path can be gotten with -o command=
		// but comm is usually sufficient for display purposes
		return name || "unknown";
	} catch {
		return "unknown";
	}
}

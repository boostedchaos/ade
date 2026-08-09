import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	currentWindowsUser,
	hardenTokenFileAcl,
	writeControlToken,
} from "./token";

const IS_WIN = process.platform === "win32";

/**
 * Windows-only: writeControlToken must leave the token file with exactly ONE
 * explicit ACE — the current user — and no inherited/other ACEs, so an
 * env-added directory ACE (e.g. CodexSandboxUsers:(RX)) cannot read the token.
 *
 * Parsing assumes icacls's en-US output (the CI/dev runners): ACE lines contain
 * `:(`, the "Successfully processed" summary line does not. SYSTEM/Admins are
 * gone after /inheritance:r because only the user is re-granted.
 */
describe.skipIf(!IS_WIN)("writeControlToken — Windows ACL hardening", () => {
	it("restricts the token file to exactly one ACE for the current user", () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-token-acl-"));
		const tokenPath = join(dir, "control.token");
		try {
			writeControlToken(tokenPath);

			// Hardening must ACTUALLY apply on win32 with icacls present. The
			// production path is best-effort (warn-and-continue), so re-run it
			// here to observe the outcome and fail LOUDLY with the captured
			// reason if it no-op'd — otherwise the ACE assertion below would
			// pass vacuously whenever icacls silently failed (e.g. an identity
			// icacls can't resolve). Idempotent: same /inheritance:r /grant:r.
			const harden = hardenTokenFileAcl(tokenPath);
			if (!harden.applied) {
				throw new Error(
					`ACL hardening did not apply: ${harden.reason ?? "unknown"}`,
				);
			}

			const out = spawnSync("icacls", [tokenPath], {
				shell: false,
				encoding: "utf-8",
				windowsHide: true,
			});
			expect(out.status).toBe(0);

			const aceLines = out.stdout
				.split(/\r?\n/)
				.filter((l) => l.includes(":("));

			// Only the explicit user grant remains: /inheritance:r stripped
			// inherited ACEs and /remove:g dropped explicit SYSTEM/Administrators.
			const user = currentWindowsUser();
			if (aceLines.length !== 1) {
				// Carry the evidence into CI so a surprising DACL is diagnosable
				// from the log rather than needing another run.
				throw new Error(
					`expected exactly 1 ACE, got ${aceLines.length}. ` +
						`resolvedUser=${JSON.stringify(user)} harden=${JSON.stringify(harden)}\n` +
						`icacls stdout:\n${out.stdout}`,
				);
			}
			expect(aceLines.length).toBe(1);
			expect(user).not.toBeNull();
			// icacls prints "DOMAIN\user"; assert the bare account name appears.
			expect(aceLines[0]).toContain(user as string);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

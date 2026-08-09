import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentWindowsUser, writeControlToken } from "./token";

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

			const out = spawnSync("icacls", [tokenPath], {
				shell: false,
				encoding: "utf-8",
				windowsHide: true,
			});
			expect(out.status).toBe(0);

			const aceLines = out.stdout
				.split(/\r?\n/)
				.filter((l) => l.includes(":("));

			// /inheritance:r stripped every inherited ACE; only the user grant
			// remains — SYSTEM and Administrators must be absent.
			expect(aceLines.length).toBe(1);
			const user = currentWindowsUser();
			expect(user).not.toBeNull();
			// icacls prints "DOMAIN\user"; assert the bare account name appears.
			expect(aceLines[0]).toContain(user as string);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

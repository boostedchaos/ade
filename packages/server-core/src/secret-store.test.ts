import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeySecretStore } from "./secret-store";

const dir = join(tmpdir(), `ade-secret-store-test-${process.pid}`);
mkdirSync(dir, { recursive: true });

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("FileKeySecretStore", () => {
	it("round-trips a secret and never stores plaintext in the blob", () => {
		const store = new FileKeySecretStore(dir);
		const secret = "sk-or-v1-super-secret-key-value";
		const blob = store.encryptString(secret);
		expect(blob.includes(Buffer.from(secret))).toBe(false);
		expect(store.decryptString(blob)).toBe(secret);
	});

	it("creates the key file once and reuses it across instances", () => {
		const a = new FileKeySecretStore(dir);
		const blob = a.encryptString("hello");
		expect(existsSync(join(dir, "secret.key"))).toBe(true);
		const keyBefore = readFileSync(join(dir, "secret.key"), "utf8");

		const b = new FileKeySecretStore(dir);
		expect(b.decryptString(blob)).toBe("hello");
		expect(readFileSync(join(dir, "secret.key"), "utf8")).toBe(keyBefore);
	});

	it("detects tampering (GCM auth tag)", () => {
		const store = new FileKeySecretStore(dir);
		const blob = store.encryptString("integrity matters");
		blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
		expect(() => store.decryptString(blob)).toThrow();
	});

	it("rejects blobs from a different key", () => {
		const otherDir = join(dir, "other");
		mkdirSync(otherDir, { recursive: true });
		const a = new FileKeySecretStore(dir);
		const b = new FileKeySecretStore(otherDir);
		const blob = a.encryptString("cross-key");
		expect(() => b.decryptString(blob)).toThrow();
	});

	it("rejects malformed blobs", () => {
		const store = new FileKeySecretStore(dir);
		expect(() => store.decryptString(Buffer.from([1, 2, 3]))).toThrow(
			"too short",
		);
		const blob = store.encryptString("x");
		blob[0] = 99;
		expect(() => store.decryptString(blob)).toThrow("version");
	});

	it("isAvailable is true for a writable dir and false for a bogus one", () => {
		expect(new FileKeySecretStore(dir).isAvailable()).toBe(true);
		expect(
			new FileKeySecretStore(
				join(dir, "does", "not", "exist"),
			).isAvailable(),
		).toBe(false);
	});
});

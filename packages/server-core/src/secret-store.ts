import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SecretStore (D10): the encryption seam behind provider-keys.
 *
 * The Electron app implements this with safeStorage (OS keychain-backed);
 * ade-server uses FileKeySecretStore below. Blobs are opaque to callers
 * and persisted base64-encoded in the local sqlite settings row.
 */
export interface SecretStore {
	/** Whether encryption is available right now (keychain unlocked, key file readable). */
	isAvailable(): boolean;
	encryptString(plaintext: string): Buffer;
	decryptString(blob: Buffer): string;
}

const KEY_FILE = "secret.key";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

/**
 * File-key implementation for headless servers: AES-256-GCM with a random
 * key stored at <homeDir>/secret.key (0600 where chmod applies; on Windows
 * the user-only home-dir ACL is the boundary).
 *
 * Honest threat model: protects the key-map at rest against file
 * exfiltration of the database alone. An attacker with arbitrary read
 * access to the whole home dir (or root) gets the key file too — same
 * trade every self-hosted tool with machine-local secrets makes.
 *
 * Blob layout: [version:1][iv:12][authTag:16][ciphertext].
 */
export class FileKeySecretStore implements SecretStore {
	private key: Buffer | null = null;

	constructor(private readonly homeDir: string) {}

	private keyPath(): string {
		return join(this.homeDir, KEY_FILE);
	}

	private loadOrCreateKey(): Buffer {
		if (this.key) return this.key;
		const path = this.keyPath();
		if (existsSync(path)) {
			const raw = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
			if (raw.length !== KEY_BYTES) {
				throw new Error(
					`secret.key is corrupt (expected ${KEY_BYTES} bytes, got ${raw.length})`,
				);
			}
			this.key = raw;
			return raw;
		}
		const key = randomBytes(KEY_BYTES);
		writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
		try {
			chmodSync(path, 0o600);
		} catch {
			// Windows: best-effort; the user-only home dir ACL is the boundary.
		}
		this.key = key;
		return key;
	}

	isAvailable(): boolean {
		try {
			this.loadOrCreateKey();
			return true;
		} catch {
			return false;
		}
	}

	encryptString(plaintext: string): Buffer {
		const key = this.loadOrCreateKey();
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext, "utf8"),
			cipher.final(),
		]);
		return Buffer.concat([
			Buffer.from([FORMAT_VERSION]),
			iv,
			cipher.getAuthTag(),
			ciphertext,
		]);
	}

	decryptString(blob: Buffer): string {
		if (blob.length < 1 + IV_BYTES + TAG_BYTES) {
			throw new Error("SecretStore blob too short");
		}
		if (blob[0] !== FORMAT_VERSION) {
			throw new Error(`Unknown SecretStore blob version: ${blob[0]}`);
		}
		const key = this.loadOrCreateKey();
		const iv = blob.subarray(1, 1 + IV_BYTES);
		const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
		const ciphertext = blob.subarray(1 + IV_BYTES + TAG_BYTES);
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]).toString("utf8");
	}
}

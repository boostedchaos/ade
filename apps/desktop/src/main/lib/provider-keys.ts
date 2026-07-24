// Moved to packages/server-core (Phase 4 extraction). This shim registers the
// Electron safeStorage-backed SecretStore (OS keychain) before re-exporting,
// so the desktop keeps keychain encryption while the server uses a file key.
import { setSecretStore } from "@ade/server-core/secret-store-host";
import { safeStorage } from "electron";

setSecretStore({
	isAvailable: () => safeStorage.isEncryptionAvailable(),
	encryptString: (plaintext) => safeStorage.encryptString(plaintext),
	decryptString: (blob) => safeStorage.decryptString(blob),
});

export * from "@ade/server-core/provider-keys";

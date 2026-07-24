import { getSupersetHomeDir } from "./app-environment";
import { FileKeySecretStore, type SecretStore } from "./secret-store";

/**
 * Host-provided SecretStore for provider-keys encryption (D10). The desktop
 * registers a safeStorage-backed store; ade-server leaves the default,
 * which is the AES-256-GCM FileKeySecretStore over ~/.ade/secret.key.
 */

let store: SecretStore | null = null;

export function setSecretStore(next: SecretStore): void {
	store = next;
}

export function getSecretStore(): SecretStore {
	if (!store) {
		store = new FileKeySecretStore(getSupersetHomeDir());
	}
	return store;
}

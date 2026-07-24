const STORAGE_KEY = "ade.token";

export function getAuthToken(): string | null {
	return localStorage.getItem(STORAGE_KEY);
}

export function setAuthToken(token: string): void {
	localStorage.setItem(STORAGE_KEY, token.trim());
}

export function clearAuthToken(): void {
	localStorage.removeItem(STORAGE_KEY);
}

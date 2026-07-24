import { getAuthToken, setAuthToken } from "./auth-token";

/**
 * Token login gate (PHASE_2 §5 / PHASE_3). The renderer makes authed tRPC
 * calls the moment it boots, so before importing it we ensure a *valid*
 * token exists. Dependency-free DOM (no React) so the heavy renderer bundle
 * isn't pulled until we're authenticated.
 *
 * Resolves once a validated token is in localStorage; the caller then
 * dynamically imports the renderer.
 */

async function validate(token: string): Promise<boolean> {
	try {
		const res = await fetch("/trpc/health.info", {
			headers: { authorization: `Bearer ${token}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}

function renderForm(onSubmit: (token: string) => Promise<void>): void {
	const root = document.querySelector("app") ?? document.body;
	root.innerHTML = `
		<div style="font-family:system-ui;background:#252525;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
			<form id="ade-login" style="width:min(360px,90vw);display:flex;flex-direction:column;gap:12px">
				<h1 style="font-size:20px;margin:0 0 4px">ADE</h1>
				<label style="font-size:13px;opacity:.8" for="tok">Access token</label>
				<input id="tok" type="password" autocomplete="off" autofocus
					style="padding:10px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee;font-size:14px" />
				<button type="submit"
					style="padding:10px;border-radius:8px;border:0;background:#c9b896;color:#111;font-weight:600;font-size:14px;cursor:pointer">Connect</button>
				<p id="err" style="color:#e06c6c;font-size:13px;min-height:16px;margin:0"></p>
				<p style="font-size:12px;opacity:.6;margin:0">The token is printed once when ade-server first starts, and stored at ~/.ade/token.</p>
			</form>
		</div>`;
	const form = document.getElementById("ade-login") as HTMLFormElement;
	const input = document.getElementById("tok") as HTMLInputElement;
	const err = document.getElementById("err") as HTMLElement;
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		err.textContent = "";
		const token = input.value.trim();
		if (!token) return;
		const btn = form.querySelector("button");
		if (btn) btn.textContent = "Connecting…";
		await onSubmit(token).catch(() => {});
		if (btn) btn.textContent = "Connect";
	});
}

export async function ensureAuthenticated(): Promise<void> {
	const existing = getAuthToken();
	if (existing && (await validate(existing))) return;

	await new Promise<void>((resolve) => {
		renderForm(async (token) => {
			if (await validate(token)) {
				setAuthToken(token);
				resolve();
			} else {
				const err = document.getElementById("err");
				if (err) err.textContent = "Invalid token — check the server console.";
			}
		});
	});
	// Clear the login DOM before the renderer mounts into <app>.
	const root = document.querySelector("app");
	if (root) root.innerHTML = "";
}

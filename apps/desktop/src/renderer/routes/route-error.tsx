import type { ErrorComponentProps } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";

/**
 * Router-level error fallback (`defaultErrorComponent`). Without one, a route
 * loader that throws takes down the whole route tree — on web this bricked the
 * UI when a loader called a tRPC procedure the server doesn't mirror yet
 * (e.g. `config.getConfigFilePath` before it was ported). Renders the error
 * in place with a way back instead.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const message = error instanceof Error ? error.message : String(error);

	return (
		<div
			style={{
				display: "flex",
				height: "100%",
				minHeight: "100vh",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px",
				textAlign: "center",
			}}
		>
			<div style={{ maxWidth: "520px" }}>
				<h1 style={{ fontSize: "18px", marginBottom: "8px" }}>
					Something went wrong loading this page
				</h1>
				<p
					style={{
						fontSize: "13px",
						opacity: 0.7,
						fontFamily: "monospace",
						wordBreak: "break-word",
					}}
				>
					{message}
				</p>
				<div
					style={{
						marginTop: "16px",
						display: "flex",
						gap: "8px",
						justifyContent: "center",
					}}
				>
					<button
						type="button"
						onClick={() => {
							reset();
							void router.navigate({ to: "/workspace", replace: true });
						}}
						style={{
							padding: "8px 20px",
							fontSize: "14px",
							background: "#333",
							color: "#e5e5e5",
							border: "1px solid #555",
							borderRadius: "6px",
							cursor: "pointer",
						}}
					>
						Back to agents
					</button>
					<button
						type="button"
						onClick={() => window.location.reload()}
						style={{
							padding: "8px 20px",
							fontSize: "14px",
							background: "transparent",
							color: "inherit",
							border: "1px solid #555",
							borderRadius: "6px",
							cursor: "pointer",
						}}
					>
						Reload
					</button>
				</div>
			</div>
		</div>
	);
}

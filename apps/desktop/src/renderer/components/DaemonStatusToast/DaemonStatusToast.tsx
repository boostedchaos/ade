import { Button } from "@superset/ui/button";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface DaemonStatusToastProps {
	status: "reconnecting" | "failed";
}

/**
 * Global indicator for the terminal-host daemon connection. Rendered as a
 * persistent bottom-right sonner toast (see useDaemonStatusListener). Design
 * per Codex gpt-5.6-sol spec: calm, plain language, one primary action, no
 * dismiss on failure so the unresolved state stays discoverable.
 */
export function DaemonStatusToast({ status }: DaemonStatusToastProps) {
	const restart = electronTrpc.terminal.restartDaemon.useMutation();
	const isFailed = status === "failed";

	const body = isFailed
		? restart.isError
			? "The terminal service didn't restart. Try again."
			: "Restart the terminal service to reconnect your existing terminal sessions."
		: "ADE is restoring the connection; your terminals will resume automatically.";

	return (
		<div
			role={isFailed ? "alert" : "status"}
			aria-live={isFailed ? "assertive" : "polite"}
			aria-atomic="true"
			className={
				isFailed
					? "pointer-events-auto flex min-w-[340px] max-w-[420px] items-start gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground"
					: "pointer-events-auto flex min-w-[340px] max-w-[420px] items-start gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-popover-foreground"
			}
		>
			{isFailed ? (
				<span
					aria-hidden="true"
					className="mt-1 size-2 shrink-0 rounded-full bg-destructive"
				/>
			) : (
				<span aria-hidden="true" className="relative mt-1 size-2 shrink-0">
					<span className="absolute inset-0 size-2 rounded-full bg-[var(--argus-ring-amber)] motion-safe:animate-ping motion-reduce:hidden" />
					<span className="relative size-2 rounded-full bg-[var(--argus-iris-waiting)]" />
				</span>
			)}

			<div className="flex min-w-0 flex-1 flex-col gap-3">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium leading-5 text-popover-foreground">
						{isFailed
							? "Terminals are disconnected."
							: "Reconnecting terminals"}
					</p>
					<p className="mt-1 text-sm leading-5 text-muted-foreground">{body}</p>
				</div>

				{isFailed && (
					<div className="flex justify-end">
						<Button
							size="sm"
							onClick={() => restart.mutate()}
							disabled={restart.isPending}
							aria-busy={restart.isPending}
							className="shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
						>
							{restart.isPending ? "Restarting…" : "Restart terminal service"}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

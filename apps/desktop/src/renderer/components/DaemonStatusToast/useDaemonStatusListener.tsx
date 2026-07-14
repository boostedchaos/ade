import { toast } from "@superset/ui/sonner";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DaemonStatusToast } from "./DaemonStatusToast";

const DAEMON_TOAST_ID = "daemon-status";
// Grace period before surfacing a `reconnecting` state: most disconnects
// self-heal within a couple of retries, and flashing a banner for every blip
// would be noise. `failed` is shown immediately.
const RECONNECTING_GRACE_MS = 3000;

function showDaemonToast(status: "reconnecting" | "failed") {
	toast.custom(() => <DaemonStatusToast status={status} />, {
		id: DAEMON_TOAST_ID,
		duration: Number.POSITIVE_INFINITY,
		position: "bottom-right",
		unstyled: true,
	});
}

export function useDaemonStatusListener() {
	const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Whether a daemon toast is currently on screen — lets a `reconnecting`
	// that follows `failed` (e.g. after the user restarts) update the toast
	// immediately instead of re-applying the grace delay.
	const toastVisible = useRef(false);

	electronTrpc.terminal.daemonStatus.useSubscription(undefined, {
		onData: (status) => {
			if (graceTimer.current) {
				clearTimeout(graceTimer.current);
				graceTimer.current = null;
			}

			if (status === "connected") {
				toast.dismiss(DAEMON_TOAST_ID);
				toastVisible.current = false;
				return;
			}

			if (status === "failed") {
				showDaemonToast("failed");
				toastVisible.current = true;
				return;
			}

			// reconnecting
			if (toastVisible.current) {
				showDaemonToast("reconnecting");
				return;
			}
			graceTimer.current = setTimeout(() => {
				showDaemonToast("reconnecting");
				toastVisible.current = true;
			}, RECONNECTING_GRACE_MS);
		},
	});

	useEffect(() => {
		return () => {
			if (graceTimer.current) clearTimeout(graceTimer.current);
		};
	}, []);
}

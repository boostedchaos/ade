import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronReactClient } from "../../lib/trpc-client";

// Gate all `refetchInterval` polling (git status, ports, resource metrics,
// settings, …) on real window focus so nothing polls the main process while the
// app is blurred or minimized, and everything refetches the moment it regains
// focus. React Query's default focus signal only tracks tab `visibilitychange`,
// which never fires when an Electron window merely loses OS focus — so we drive
// the focus state ourselves from window focus/blur plus visibility.
if (typeof window !== "undefined") {
	focusManager.setEventListener((handleFocus) => {
		const onChange = () =>
			handleFocus(document.visibilityState === "visible" && document.hasFocus());
		window.addEventListener("focus", onChange);
		window.addEventListener("blur", onChange);
		document.addEventListener("visibilitychange", onChange);
		return () => {
			window.removeEventListener("focus", onChange);
			window.removeEventListener("blur", onChange);
			document.removeEventListener("visibilitychange", onChange);
		};
	});
}

// Shared QueryClient for tRPC hooks and router loaders
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			networkMode: "always",
			retry: false,
		},
		mutations: {
			networkMode: "always",
			retry: false,
		},
	},
});

/**
 * Provider for Electron IPC tRPC client.
 * QueryClient is shared with router context for loader prefetching.
 */
export function ElectronTRPCProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<electronTrpc.Provider
			client={electronReactClient}
			queryClient={queryClient}
		>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</electronTrpc.Provider>
	);
}

// Export for router context
export { queryClient as electronQueryClient };

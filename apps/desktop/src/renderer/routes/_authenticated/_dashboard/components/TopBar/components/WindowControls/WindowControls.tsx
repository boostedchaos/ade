import { useEffect } from "react";
import {
	HiMiniMinus,
	HiMiniSquare2Stack,
	HiMiniStop,
	HiMiniXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function WindowControls() {
	const minimizeMutation = electronTrpc.window.minimize.useMutation();
	const maximizeMutation = electronTrpc.window.maximize.useMutation();
	const closeMutation = electronTrpc.window.close.useMutation();
	const { data: isMaximized, refetch } =
		electronTrpc.window.isMaximized.useQuery();

	// The window can also be maximized/restored outside this button (title-bar
	// double-click, Win+Up, snap). `resize` fires for all of those, so re-query
	// on it to keep the maximize/restore glyph in sync.
	useEffect(() => {
		const onResize = () => refetch();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [refetch]);

	const handleMinimize = () => {
		minimizeMutation.mutate();
	};

	const handleMaximize = () => {
		maximizeMutation.mutate();
	};

	const handleClose = () => {
		closeMutation.mutate();
	};

	// ponytail: 46×32 native caption-button sizing, but kept in the existing
	// rounded in-toolbar style (this cluster sits inside the padded TopBar right
	// group, not flush in the corner). True flush-native strip = a TopBar layout
	// change, out of scope here.
	return (
		<div className="no-drag flex items-center h-full gap-1 pr-1">
			<button
				type="button"
				aria-label="Minimize window"
				className="no-drag flex h-8 w-[46px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onClick={handleMinimize}
			>
				<HiMiniMinus className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				aria-label={isMaximized ? "Restore window" : "Maximize window"}
				className="no-drag flex h-8 w-[46px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onClick={handleMaximize}
			>
				{isMaximized ? (
					<HiMiniSquare2Stack className="h-3.5 w-3.5" />
				) : (
					<HiMiniStop className="h-3 w-3" />
				)}
			</button>
			<button
				type="button"
				aria-label="Close window"
				className="no-drag flex h-8 w-[46px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
				onClick={handleClose}
			>
				<HiMiniXMark className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

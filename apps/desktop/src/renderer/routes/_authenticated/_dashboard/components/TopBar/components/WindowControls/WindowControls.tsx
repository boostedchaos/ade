import { useEffect } from "react";
import { HiMiniSquare2Stack, HiMiniXMark } from "react-icons/hi2";
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

	// Argus caption buttons (DESIGN-BRIEF.md §2b): three 46px-wide hit areas,
	// full titlebar height, flush in the corner, drawn as primitives rather
	// than icon-font glyphs so they match Windows 11's own weights —
	// minimize = an 11×1px bar, maximize = a 10×10px 1px-border square,
	// close = an 11×11px ✕. All in --argus-text-body (#9AA5B6).
	//
	// WHY NOT `titleBarOverlay`: SPEC.md §Phase 4 asks for
	// `titleBarOverlay: { color: '#0E1219', symbolColor: '#9AA5B6', height: 40 }`
	// in main/windows/main.ts. This app has never set that option — it uses
	// `frame: false` and draws its own controls, which is what this component
	// is. Adding the overlay would paint NATIVE caption buttons on top of these
	// ones, so the window would show two sets. The overlay's stated colors and
	// height are applied here and via --argus-titlebar-height / --argus-panel
	// instead, which is the same result on screen.
	const captionButton =
		"no-drag flex w-[46px] items-center justify-center transition-colors";
	const captionStyle = {
		height: "var(--argus-titlebar-height)",
		color: "var(--argus-text-body)",
	} as const;

	return (
		<div className="no-drag flex items-stretch h-full">
			<button
				type="button"
				aria-label="Minimize window"
				className={`${captionButton} hover:bg-[var(--argus-raised)]`}
				style={captionStyle}
				onClick={handleMinimize}
			>
				<span
					aria-hidden
					className="block bg-current"
					style={{ width: 11, height: 1 }}
				/>
			</button>
			<button
				type="button"
				aria-label={isMaximized ? "Restore window" : "Maximize window"}
				className={`${captionButton} hover:bg-[var(--argus-raised)]`}
				style={captionStyle}
				onClick={handleMaximize}
			>
				{isMaximized ? (
					<HiMiniSquare2Stack className="h-[11px] w-[11px]" />
				) : (
					<span
						aria-hidden
						className="block border border-current"
						style={{ width: 10, height: 10 }}
					/>
				)}
			</button>
			<button
				type="button"
				aria-label="Close window"
				className={`${captionButton} hover:bg-destructive hover:text-destructive-foreground`}
				style={captionStyle}
				onClick={handleClose}
			>
				<HiMiniXMark style={{ width: 11, height: 11 }} />
			</button>
		</div>
	);
}

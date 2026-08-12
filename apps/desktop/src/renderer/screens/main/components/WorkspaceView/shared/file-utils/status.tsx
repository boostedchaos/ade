import type { ReactNode } from "react";
import {
	LuCopy,
	LuFileOutput,
	LuPencilLine,
	LuPlus,
	LuX,
} from "react-icons/lu";
import type { FileStatus } from "shared/changes-types";

export function getStatusColor(status: FileStatus): string {
	switch (status) {
		case "added":
		case "untracked":
			return "text-[var(--argus-pass)] dark:text-[var(--argus-pass)]";
		case "modified":
			return "text-[var(--argus-iris-waiting)] dark:text-[var(--argus-iris-waiting)]";
		case "deleted":
			return "text-[var(--destructive)] dark:text-[var(--destructive)]";
		case "renamed":
			return "text-[var(--argus-iris-working)] dark:text-[var(--argus-iris-working)]";
		case "copied":
			return "text-[var(--chart-4)] dark:text-[var(--chart-4)]";
		default:
			return "text-muted-foreground";
	}
}

export function getStatusIndicator(status: FileStatus): ReactNode {
	const iconClass = "w-3 h-3";
	switch (status) {
		case "added":
		case "untracked":
			return <LuPlus className={iconClass} />;
		case "modified":
			return <LuPencilLine className={iconClass} />;
		case "deleted":
			return <LuX className={iconClass} />;
		case "renamed":
			return <LuFileOutput className={iconClass} />;
		case "copied":
			return <LuCopy className={iconClass} />;
		default:
			return null;
	}
}

import { cn } from "@superset/ui/utils";
import { ArgusLockup } from "renderer/screens/main/components/Iris";

interface SupersetLogoProps {
	className?: string;
}

/**
 * The app wordmark.
 *
 * Under Argus this is the mark + wordmark lockup, not a bare text string: the
 * iris and the letterforms are one object (DESIGN-BRIEF.md "The iris").
 *
 * The old implementation put `aria-label` on a bare `<span>`, which biome
 * flagged (`useAriaPropsSupportedByRole`) because a span has no role to carry
 * it. `ArgusLockup` labels the mark's `<svg role="img">` instead, so the name
 * lands on an element that can hold it.
 *
 * The component name is left alone deliberately — renaming it is a code-level
 * rename with no user-visible surface, and SPEC.md §Decisions scopes the
 * rename to things a user actually sees.
 */
export function SupersetLogo({ className }: SupersetLogoProps) {
	return (
		<ArgusLockup
			markSize={40}
			wordmarkSize={30}
			display
			className={cn("select-none", className)}
		/>
	);
}

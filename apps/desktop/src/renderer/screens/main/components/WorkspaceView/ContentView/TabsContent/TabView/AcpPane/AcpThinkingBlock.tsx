import {
	Reasoning,
	ReasoningTrigger,
} from "@superset/ui/ai-elements/reasoning";
import { CollapsibleContent } from "@superset/ui/collapsible";

/**
 * An `agent_thought_chunk` run.
 *
 * Current models default `thinking.display: "omitted"` and the adapter drops
 * empty thought blocks, so zero of these is the NORMAL case, not breakage —
 * which is why nothing else in the pane renders a placeholder for them.
 *
 * `defaultOpen={false}` is load-bearing beyond the collapsed default: it also
 * disables `Reasoning`'s auto-close timer, which would otherwise fight a user
 * who opened the block while the turn was still streaming.
 *
 * The body is a plain `whitespace-pre-wrap` block, NOT `ReasoningContent`:
 * that component pipes its children through `Streamdown`, which would render
 * thinking as markdown while assistant text beside it stays plain — two rules
 * for the same agent prose. One rule, and it is the pane's existing one; the
 * markdown gap is named in the design doc's out-of-scope list and closes for
 * both kinds together or not at all. `CollapsibleContent` is the same module
 * `Reasoning` builds its shell from, so it reads the same Radix context.
 */
export function AcpThinkingBlock({ text }: { text: string }) {
	return (
		<Reasoning className="mb-3" defaultOpen={false}>
			{/* `getThinkingMessage`, not children: children would replace the whole
			    row and take the disclosure chevron with it. */}
			<ReasoningTrigger
				className="text-xs"
				getThinkingMessage={() => <span>Thinking</span>}
			/>
			<CollapsibleContent className="mt-1 whitespace-pre-wrap break-words text-muted-foreground text-xs outline-none">
				{text}
			</CollapsibleContent>
		</Reasoning>
	);
}

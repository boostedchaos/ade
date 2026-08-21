import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@superset/ui/ai-elements/reasoning";

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
			<ReasoningContent className="mt-1 text-xs">{text}</ReasoningContent>
		</Reasoning>
	);
}

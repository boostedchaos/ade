import {
	type AskAgentResult,
	askAgent,
	MailError,
	type MailRecipient,
} from "@ade/server-core/agent-mail";
import { resolveAgentWorktreePath } from "@ade/server-core/agent-worktree";
import { workspaces } from "@superset/local-db";
import { isNotNull } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { getProviderKey } from "main/lib/provider-keys";
import { z } from "zod";
import { publicProcedure, router } from "..";

/**
 * Agent mail (issue #45) — desktop mirror of the server's `mail` router
 * (mirror rule, precedent 9cc1894). The agent-facing HTTP entry point
 * (POST /mail/ask on the hook receiver) is server-only in v1; this procedure
 * keeps the router contract in parity and gives the renderer a path to ask.
 */
async function performMailAsk(input: {
	from: string;
	to: string;
	question: string;
	depth: number;
}): Promise<AskAgentResult> {
	const agents = localDb
		.select()
		.from(workspaces)
		.where(isNotNull(workspaces.runtime))
		.all()
		.filter((w) => !w.deletingAt);

	const fromAgent = agents.find((a) => a.id === input.from);
	if (!fromAgent) {
		throw new MailError(`Unknown asking agent id "${input.from}"`);
	}

	const wanted = input.to.trim().toLowerCase();
	const matches = agents.filter((a) => (a.name || "").toLowerCase() === wanted);
	if (matches.length === 0) {
		const names = agents
			.map((a) => a.name)
			.filter(Boolean)
			.join(", ");
		throw new MailError(`No agent named "${input.to}". Roster: ${names}`);
	}
	if (matches.length > 1) {
		throw new MailError(
			`Agent name "${input.to}" is ambiguous (${matches.length} matches) — rename one of them`,
		);
	}
	const match = matches[0];
	if (!match.runtime) {
		throw new MailError(`Agent "${match.name}" has no runtime configured`);
	}

	const to: MailRecipient = {
		id: match.id,
		name: match.name,
		runtime: match.runtime,
		worktreePath: resolveAgentWorktreePath(match.id, match.worktreeId),
	};

	return askAgent({
		from: { id: fromAgent.id, name: fromAgent.name },
		to,
		question: input.question,
		depth: input.depth,
		openRouterKey: getProviderKey("openrouter"),
	});
}

export const createMailRouter = () => {
	return router({
		ask: publicProcedure
			.input(
				z.object({
					from: z.string().min(1),
					to: z.string().min(1),
					question: z.string().min(1),
					depth: z.number().int().min(0).default(0),
				}),
			)
			.mutation(({ input }) => performMailAsk(input)),
	});
};

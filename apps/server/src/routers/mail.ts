import {
	type AskAgentResult,
	askAgent,
	MailError,
	type MailRecipient,
} from "@ade/server-core/agent-mail";
import { resolveAgentWorktreePath } from "@ade/server-core/agent-worktree";
import { localDb } from "@ade/server-core/local-db";
import { getProviderKey } from "@ade/server-core/provider-keys";
import { workspaces } from "@superset/local-db";
import { isNotNull } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/**
 * Agent mail (issue #45). `performMailAsk` is shared by the tRPC procedure
 * and the hook receiver's POST /mail/ask route (the path agents call from
 * inside their terminal sessions) — see server.ts.
 */

function roster() {
	return localDb
		.select()
		.from(workspaces)
		.where(isNotNull(workspaces.runtime))
		.all()
		.filter((w) => !w.deletingAt);
}

export async function performMailAsk(input: {
	from: string;
	to: string;
	question: string;
	depth: number;
}): Promise<AskAgentResult> {
	const agents = roster();

	const fromAgent = agents.find((a) => a.id === input.from);
	if (!fromAgent) {
		throw new MailError(
			`Unknown asking agent id "${input.from}" — pass your SUPERSET_WORKSPACE_ID as "from"`,
		);
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

export const mailRouter = router({
	ask: authedProcedure
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

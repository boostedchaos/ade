import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnimatePresence } from "framer-motion";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient as trpcClient } from "renderer/lib/trpc-client";
import { NotFound } from "renderer/routes/not-found";
import { TeamDashboard } from "./-components/team-dashboard";
import { ExternalWorktreesBanner } from "./components/ExternalWorktreesBanner";
import { CreateAgentWizard } from "./CreateAgentWizard";

export const Route = createFileRoute(
	"/_authenticated/_dashboard/project/$projectId/",
)({
	component: ProjectPage,
	notFoundComponent: NotFound,
	loader: async ({ params, context }) => {
		const queryKey = [
			["projects", "get"],
			{ input: { id: params.projectId }, type: "query" },
		];

		try {
			await context.queryClient.ensureQueryData({
				queryKey,
				queryFn: () => trpcClient.projects.get.query({ id: params.projectId }),
			});
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found")) {
				throw notFound();
			}
			throw error;
		}
	},
});

function ProjectPage() {
	const { projectId } = Route.useParams();

	const { data: project } = electronTrpc.projects.get.useQuery({
		id: projectId,
	});

	const { data: groups } = electronTrpc.workspaces.getAllGrouped.useQuery();

	if (!project) {
		return null;
	}

	const workspaces = groups?.find(
		(group) => group.project.id === projectId,
	)?.workspaces;

	return (
		<div className="flex-1 h-full flex flex-col overflow-hidden bg-background">
			<AnimatePresence>
				<ExternalWorktreesBanner projectId={projectId} />
			</AnimatePresence>

			{workspaces === undefined ? null : workspaces.length > 0 ? (
				<TeamDashboard projectId={projectId} />
			) : (
				<CreateAgentWizard projectId={projectId} />
			)}
		</div>
	);
}

import { electronTrpc } from "renderer/lib/electron-trpc";
import { BoardColumn } from "./BoardColumn";
import type { WorkBoardData } from "./types";

interface WorkBoardProps {
	board: WorkBoardData;
	isLoading: boolean;
}

/**
 * Todo / Doing / Done board built from the project's issues + linked PRs. The
 * Done column is visually muted since it's reference, not active work.
 */
export function WorkBoard({ board, isLoading }: WorkBoardProps) {
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const onOpen = (url: string) => openUrl.mutate(url);

	return (
		<section className="space-y-3">
			<h2 className="text-sm font-medium text-muted-foreground">Work</h2>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
				<BoardColumn
					title="Todo"
					items={board.todo}
					isLoading={isLoading}
					onOpen={onOpen}
				/>
				<BoardColumn
					title="Doing"
					items={board.doing}
					isLoading={isLoading}
					onOpen={onOpen}
				/>
				<BoardColumn
					title="Done"
					items={board.done}
					isLoading={isLoading}
					muted
					onOpen={onOpen}
				/>
			</div>
		</section>
	);
}

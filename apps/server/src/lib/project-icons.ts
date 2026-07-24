import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPERSET_HOME_DIR } from "@ade/server-core/app-environment";

/**
 * Category (project) icon storage — server port of the desktop's
 * main/lib/project-icons.ts `projects` namespace. Same on-disk layout
 * (~/.ade/project-icons/<id>.<ext>) and same superset-icon:// protocol
 * URLs, so icons set from either surface are visible to both.
 */

const PROJECT_ICONS_DIR = join(SUPERSET_HOME_DIR, "project-icons");

/** Max icon file size: 512KB */
const MAX_ICON_SIZE = 512 * 1024;

function getProjectIconFile(projectId: string): string | null {
	if (!existsSync(PROJECT_ICONS_DIR)) return null;

	const files = readdirSync(PROJECT_ICONS_DIR);
	const match = files.find((f) => {
		const name = f.substring(0, f.lastIndexOf("."));
		return name === projectId;
	});

	return match ? join(PROJECT_ICONS_DIR, match) : null;
}

export function deleteProjectIcon(projectId: string): void {
	const existing = getProjectIconFile(projectId);
	if (existing) {
		unlinkSync(existing);
	}
}

export async function saveProjectIconFromDataUrl({
	projectId,
	dataUrl,
}: {
	projectId: string;
	dataUrl: string;
}): Promise<string> {
	if (!existsSync(PROJECT_ICONS_DIR)) {
		mkdirSync(PROJECT_ICONS_DIR, { recursive: true });
	}
	deleteProjectIcon(projectId);

	// Parse data URL: data:image/png;base64,<data>
	const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
	if (!match) {
		throw new Error("Invalid data URL format");
	}

	const ext = match[1] === "jpeg" ? "jpg" : match[1];
	const buffer = Buffer.from(match[2], "base64");

	if (buffer.length > MAX_ICON_SIZE) {
		throw new Error(
			`Icon file too large (${Math.round(buffer.length / 1024)}KB). Maximum is ${MAX_ICON_SIZE / 1024}KB.`,
		);
	}

	await writeFile(join(PROJECT_ICONS_DIR, `${projectId}.${ext}`), buffer);

	return `superset-icon://projects/${projectId}`;
}

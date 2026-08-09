import { type Command, compact } from "../command";

export const eventCommands: Command[] = [
	{
		name: "events",
		group: "Events",
		summary: "Stream control-plane events as NDJSON",
		kind: "stream",
		options: [
			{
				name: "kinds",
				type: "string",
				placeholder: "<a,b>",
				description:
					"Comma-separated event kinds to subscribe to (default: all)",
			},
			{
				name: "once",
				type: "boolean",
				description: "Exit after the connection drops instead of reconnecting",
			},
		],
		notes:
			"Prints one JSON object per line and never exits on its own. Reconnects\n" +
			"with backoff if the app restarts. Kinds in v1: pane-created, pane-closed,\n" +
			"pane-focused, agent-state-changed, notification. Unknown kinds are passed\n" +
			"through unchanged.",
		build: (input) => {
			const raw = input.options.kinds;
			const kinds =
				typeof raw === "string"
					? raw
							.split(",")
							.map((k) => k.trim())
							.filter(Boolean)
					: ["*"];
			return { cmd: "subscribe", args: compact({ kinds }) };
		},
	},
];

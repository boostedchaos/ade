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
			"Prints one JSON object per line. Without --once it never exits on its\n" +
			"own, reconnecting with backoff if the app restarts; with --once it exits\n" +
			"0 the first time the connection drops (3 if it never connected). Kinds\n" +
			"in v1: pane-created, pane-closed, pane-focused, agent-state-changed,\n" +
			"notification. Pane events cover BOTH CLI-initiated and user-initiated\n" +
			"layout changes. Unknown kinds are passed through unchanged.",
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

import { parseArgs } from "./args.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { Collaboration } from "./collaboration.mjs";
import { startWeb } from "./web-server.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";

export async function handleWeb(argv) {
	const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd", "port"], aliasMap: { C: "cwd" } });
	if (positionals.length > 1 || (positionals.length && options.cwd)) throw new Error("Specify one project folder, either as an argument or with --cwd.");
	const port = Number(options.port ?? 3210);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer between 0 and 65535.");
	const cwd = resolveWorkspaceRoot(path.resolve(options.cwd ?? positionals[0] ?? process.cwd()));
	const app = await startWeb({ cwd, port });
	console.log(`Duo — Codex × Claude\nProject: ${cwd}\nOpen this private sign-in link:\n${app.loginUrl}\nKeep this terminal open. Press Enter for a new sign-in link. Ctrl+C stops the server.`);
	if (process.stdin.isTTY) {
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (text) => { if (text.includes("\n") || text.includes("\r")) console.log(`New sign-in link (the previous unused link no longer works):\n${app.newLoginUrl()}`); });
	}
	let shuttingDown = false;
	const stop = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.stdin.destroy();
		try { await app.close(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].filter((name) => name in os.constants.signals)) process.once(signal, stop);
}

export async function handleCollaborate(argv) {
	const [command = "status", ...rest] = argv;
	const { options, positionals } = parseArgs(rest, {
		valueOptions: ["cwd", "mode", "policy", "codex-model", "claude-model", "model-policy", "language", "plan", "revision", "max-rounds", "max-passes"],
		booleanOptions: ["json"], aliasMap: { C: "cwd" }
	});
	const cwd = resolveWorkspaceRoot(path.resolve(options.cwd ?? process.cwd()));
	const manager = new Collaboration(cwd);
	try {
		let run;
		if (command === "start") run = manager.create({
			task: positionals.join(" "), mode: options.mode ?? "medium", policy: options.policy,
			codexModel: options["codex-model"], claudeModel: options["claude-model"], modelPolicy: options["model-policy"],
			maxRounds: options["max-rounds"], maxPasses: options["max-passes"], language: options.language
		});
		else if (command === "status" && !positionals[0]) { console.log(JSON.stringify(manager.list(), null, 2)); return; }
		else {
			const id = positionals[0];
			if (!id) throw new Error("A collaboration ID is required.");
			if (command === "status" || command === "transcript") run = manager.get(id);
			else run = manager.action(id, command, {
				requestId: randomUUID(), planRevision: options.revision ?? (command === "revise" ? manager.get(id).planRevision : undefined),
				...(command === "language" ? { language: options.language } : {}),
				...(command === "revise" && options.plan ? { plan: fs.readFileSync(path.resolve(cwd, options.plan), "utf8") } : {})
			});
		}
		await manager.running.get(run.id)?.promise;
		run = manager.get(run.id);
		if (command === "transcript") console.log(run.messages.map((message) => `${message.sender} → ${message.recipient}\n${message.content}`).join("\n\n"));
		else console.log(JSON.stringify(run, null, 2));
	} finally { await manager.close(); }
}

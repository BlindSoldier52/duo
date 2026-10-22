#!/usr/bin/env node
const HELP = `Duo — Codex × Claude collaboration

Usage:
  duo install
  duo web [project-folder] [--port <port>]
  node duo.mjs web [--cwd <project>] [--port <port>]
  node duo.mjs collaborate start [--mode medium|skip-everything] [task]
  node duo.mjs collaborate status [run-id]
  node duo.mjs collaborate transcript <run-id>
  node duo.mjs collaborate approve <run-id> --revision <plan-hash>
  node duo.mjs collaborate revise <run-id> --plan <file>
  node duo.mjs collaborate language <run-id> --language <name-or-code>
  node duo.mjs collaborate resume|pause|cancel|reject <run-id>

Run options: --cwd, --codex-model, --claude-model, --model-policy adaptive|fixed,
--language, --max-rounds, --max-passes. Models are adaptive and replies are English
by default. Use the web dashboard for the full task and VPS configuration.

The project defaults to the current directory. Local tasks do not require Git
or a package.json. Run node duo.mjs install from the checkout once to install
the self-contained app under your Duo data directory (AppData/duo on Windows).
Read guide.md for setup and safety requirements. Keep sign-in links private.`;

async function main() {
	const [command = "web", ...args] = process.argv.slice(2);
	if (["help", "--help", "-h"].includes(command) || (["web", "collaborate"].includes(command) && ["--help", "-h"].includes(args[0]))) {
		console.log(HELP);
		return;
	}
	if (command === "install") {
		if (args.length) throw new Error("duo install does not accept arguments. Use DUO_HOME to override its data directory.");
		const { printInstallation } = await import("./scripts/install-duo.mjs");
		printInstallation();
		return;
	}
	if (!["web", "collaborate"].includes(command)) throw new Error(`Unknown Duo command: ${command}. Run node duo.mjs help.`);
	const cli = await import("./plugins/codex/scripts/lib/collaboration-cli.mjs");
	if (command === "web") await cli.handleWeb(args);
	else await cli.handleCollaborate(args);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

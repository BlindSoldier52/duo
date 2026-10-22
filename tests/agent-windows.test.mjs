import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractResponse, handleActivity, handleStop } from "../plugins/codex/scripts/lib/claude-turn-hook.mjs";
import { cleanEnvironment } from "../plugins/codex/scripts/lib/claude.mjs";
import { fixture, settle } from "./collaboration-fixture.mjs";

const answer = { message: "Done", plan: "", verdict: "approve", blockingIssues: [], notes: "", routing: null };

function scratch(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "duo-window-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("the Claude stop hook reads plain, fenced, and surrounded JSON answers", () => {
	assert.deepEqual(extractResponse(JSON.stringify(answer)), answer);
	assert.deepEqual(extractResponse(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``), answer);
	assert.deepEqual(extractResponse(`Here it is:\n${JSON.stringify(answer)}\nThanks.`), answer);
	assert.throws(() => extractResponse("No JSON here."), /JSON/);
});

test("the Claude stop hook asks for a correction, then gives up after three attempts", (t) => {
	const file = path.join(scratch(t), "result.json");
	for (let attempt = 1; attempt <= 3; attempt++) {
		const decision = handleStop({ last_assistant_message: "Plain text", session_id: "s" }, file);
		assert.equal(decision.decision, "block");
		assert.equal(fs.existsSync(file), false);
	}
	assert.equal(handleStop({ last_assistant_message: "Plain text", session_id: "s" }, file), null);
	assert.match(JSON.parse(fs.readFileSync(file, "utf8")).error, /after 3 corrections/);
});

test("the Claude stop hook saves a valid answer and the activity hook records tools", (t) => {
	const directory = scratch(t);
	const file = path.join(directory, "result.json");
	assert.equal(handleStop({ last_assistant_message: JSON.stringify(answer), session_id: "session" }, file), null);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { response: answer, session: "session" });
	const activity = path.join(directory, "activity.jsonl");
	handleActivity({ tool_name: "Read", tool_input: { file_path: path.join(directory, "src", "main.rs") }, cwd: directory }, activity);
	assert.deepEqual(JSON.parse(fs.readFileSync(activity, "utf8")), { message: `Read ${path.join("src", "main.rs")}` });
});

test("Claude never inherits the session markers of the process that started Duo", () => {
	const env = cleanEnvironment({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_MESSAGING_TOKEN: "secret", CLAUDE_PID: "1", CLAUDE_CONFIG_DIR: "keep", PATH: "keep" });
	assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "CODEX_COMPANION_ORCHESTRATED", "PATH"]);
});

test("agent windows default to the platform and reach the runner", async (t) => {
	const seen = [];
	const { manager } = fixture(t, (_agent, options) => { seen.push(options.windows); });
	const shown = await settle(manager, manager.create({ task: "Plan", windows: true }).id);
	assert.equal(shown.windows, true);
	assert.ok(seen.every((value) => value === true));
	const hidden = await settle(manager, manager.create({ task: "Plan", windows: false }).id);
	assert.equal(hidden.windows, false);
	assert.equal(manager.get(manager.create({ task: "Plan" }).id).windows, process.platform === "win32");
});

test("the Claude activity hook shows the shell command it runs", (t) => {
	const activity = path.join(scratch(t), "activity.jsonl");
	handleActivity({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: process.cwd() }, activity);
	assert.deepEqual(JSON.parse(fs.readFileSync(activity, "utf8")), { message: "Running command: npm test" });
});

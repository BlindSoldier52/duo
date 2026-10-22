import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { workspaceRevision } from "../plugins/codex/scripts/lib/collaboration-workspace.mjs";
import { execute } from "../plugins/codex/scripts/lib/collaboration-process.mjs";
import { claudeTools, describeCommand, runClaude } from "../plugins/codex/scripts/lib/claude.mjs";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { Collaboration, isStopRequest } from "../plugins/codex/scripts/lib/collaboration.mjs";

function action(manager, run, name, input = {}) {
	return manager.action(run.id, name, { requestId: randomUUID(), ...input });
}

test("Medium waits for exact human approval, then verifies and obtains both final votes", async (t) => {
	const { manager, calls, cwd } = fixture(t);
	let run = manager.create({ task: "Create result.txt", commands: [[process.execPath, "-e", "require('fs').accessSync('result.txt')"]] });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "awaiting_user");
	assert.equal(fs.existsSync(path.join(cwd, "result.txt")), false);
	assert.ok(calls.every((call) => !call.write));
	assert.equal(calls.filter((call) => call.phase === "proposal").length, 2);
	assert.equal(run.models.claude, "claude-reported");
	assert.throws(() => action(manager, run, "approve", { planRevision: "stale" }), /current reviewed plan/);
	action(manager, run, "approve", { planRevision: run.planRevision });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "completed", run.error);
	assert.equal(run.checks[0].status, "passed");
	assert.equal(run.votes.codex.revision, run.votes.claude.revision);
	assert.equal(run.votes.codex.revision, workspaceRevision(cwd));
	assert.equal(calls.filter((call) => call.write).length, 1);
});

test("editing a reviewed plan invalidates votes and rejects stale editing", async (t) => {
	const { manager } = fixture(t);
	let run = await settle(manager, manager.create({ task: "Plan a change" }).id);
	const original = run.planRevision;
	action(manager, run, "revise", { plan: "# Changed plan\nPreserve existing work.", planRevision: original });
	run = await settle(manager, run.id);
	assert.notEqual(run.planRevision, original);
	assert.equal(run.phase, "awaiting_user");
	assert.equal(run.planVotes.codex.revision, run.planRevision);
	assert.throws(() => action(manager, run, "revise", { plan: "Old edit", planRevision: original }), /changed/);
	assert.throws(() => action(manager, run, "approve", { planRevision: original }), /current reviewed plan/);
});

test("failed verification can never be completed even when both agents approve", async (t) => {
	const { manager } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything", maxRounds: 1,
		commands: [[process.execPath, "-e", "process.exit(1)"]] }).id);
	assert.equal(run.phase, "needs_attention");
	assert.equal(run.checks[0].status, "failed");
	assert.match(run.error, /round limit/);
});

test("one blocked review prevents completion and preserves disagreement", async (t) => {
	const { manager } = fixture(t, (agent, options) => {
		if (agent === "claude" && options.phase === "review") return {
			response: { message: "Missing behavior", plan: "", verdict: "blocked", blockingIssues: ["Acceptance criterion is missing"] }
		};
	});
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything", maxRounds: 1 }).id);
	assert.equal(run.phase, "needs_attention");
	assert.equal(run.votes.claude.verdict, "blocked");
});

test("workspace changes invalidate plan approval", async (t) => {
	const { manager, cwd } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Plan a change" }).id);
	fs.appendFileSync(path.join(cwd, "README.md"), "User change\n");
	assert.throws(() => action(manager, run, "approve", { planRevision: run.planRevision }), /Workspace changed/);
});

test("targeted chat invokes the intended participant and does not fabricate the other response", async (t) => {
	const { manager, calls } = fixture(t);
	let run = await settle(manager, manager.create({ task: "Plan a change" }).id);
	action(manager, run, "message", { recipient: "claude", content: "Explain the tradeoff" });
	run = await settle(manager, run.id);
	assert.deepEqual(calls.filter((call) => call.phase === "chat").map((call) => call.agent), ["claude"]);
	assert.equal(run.messages.filter((message) => message.phase === "chat").length, 1);
	assert.equal(run.phase, "awaiting_user");
});

test("action request IDs prevent duplicate execution", async (t) => {
	const { manager } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	const input = { requestId: randomUUID(), recipient: "codex", content: "Question" };
	manager.action(run.id, "message", input);
	manager.action(run.id, "message", input);
	await settle(manager, run.id);
	assert.equal(manager.get(run.id).messages.filter((message) => message.content === "Question").length, 1);
	assert.throws(() => manager.action(run.id, "message", { ...input, content: "Different" }), /already used/);
});

test("pause finishes the current parallel operations but schedules no new one until resumed", async (t) => {
	let unblock;
	let first = true;
	const { manager, calls } = fixture(t, async () => {
		if (first) { first = false; await new Promise((resolve) => { unblock = resolve; }); }
	});
	const run = manager.create({ task: "Plan" });
	action(manager, run, "pause");
	unblock();
	let paused = await settle(manager, run.id);
	assert.equal(paused.paused, true);
	assert.deepEqual(calls.map((call) => call.phase), ["proposal", "proposal"]);
	action(manager, paused, "resume");
	paused = await settle(manager, run.id);
	assert.equal(paused.phase, "awaiting_user");
});

test("cancellation waits for the active runner to stop and records no approval", async (t) => {
	const { manager } = fixture(t, async (_agent, options) => {
		await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
	});
	const run = manager.create({ task: "Long task" });
	action(manager, run, "cancel");
	const cancelled = await settle(manager, run.id);
	assert.equal(cancelled.phase, "cancelled");
	assert.deepEqual(cancelled.votes, {});
});

test("invalid agent output cannot produce a plan or a fabricated agreement", async (t) => {
	const { manager } = fixture(t, () => ({ response: { message: "Done" } }));
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	assert.equal(run.phase, "needs_attention");
	assert.match(run.error, /invalid collaboration response/);
});

test("process arguments are passed literally and cancellation terminates a native child", async () => {
	const value = "hello; $(not-a-command) & \"quoted\"";
	const result = await execute(process.execPath, ["-e", "console.log(process.argv[1])", value]);
	assert.equal(result.stdout.trim(), value);
	const controller = new AbortController();
	const pending = execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
	setTimeout(() => controller.abort(new Error("Stopped")), 100);
	await assert.rejects(pending, /Stopped/);
});

test("Claude adapter uses subscription-compatible restricted tools and validates structured output", async () => {
	let invocation;
	const result = await runClaude(process.cwd(), {
		prompt: "Inspect only", model: "claude-opus-5-5", session: "prior-session", write: false,
		execute: async (command, args, options) => {
			if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
			invocation = { command, args, options };
			return { status: 0, stderr: "", stdout: JSON.stringify({ session_id: "session", structured_output: { message: "OK", plan: "Plan", verdict: "approve", blockingIssues: [] } }) + "\x1b[2G" };
		}
	});
	assert.equal(result.session, "session");
	assert.equal(invocation.command, "claude");
	assert.ok(invocation.args.includes("--restricted"));
	assert.ok(!invocation.args.includes("--bare"));
	assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "Read,Glob,Grep");
	assert.equal(invocation.options.input, "Inspect only");
});

test("failed queued chat stops instead of automatically consuming repeated agent calls", async (t) => {
	const { manager, calls } = fixture(t, (_agent, options) => {
		if (options.phase === "chat") throw new Error("Provider unavailable");
	});
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	action(manager, run, "message", { recipient: "codex", content: "Question" });
	const failed = await settle(manager, run.id);
	assert.equal(failed.phase, "needs_attention");
	assert.equal(manager.running.size, 0);
	assert.equal(calls.filter((item) => item.phase === "chat").length, 1);
});

test("questions after completion stay read-only and do not reimplement the task", async (t) => {
	const { manager, calls } = fixture(t);
	const completed = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything" }).id);
	assert.equal(completed.phase, "completed");
	const writes = calls.filter((item) => item.write).length;
	action(manager, completed, "message", { recipient: "both", content: "Explain the result" });
	assert.equal((await settle(manager, completed.id)).phase, "completed");
	assert.equal(calls.filter((item) => item.write).length, writes);
	assert.equal(calls.filter((item) => item.phase === "chat").length, 2);
});

test("workspace tasks are serialized and paused queued tasks do not block the next task", async (t) => {
	let unblock;
	let first = true;
	const { manager } = fixture(t, async () => {
		if (first) { first = false; await new Promise((resolve) => { unblock = resolve; }); }
	});
	const one = manager.create({ task: "First" });
	const two = manager.create({ task: "Second" });
	const three = manager.create({ task: "Third" });
	assert.equal(manager.get(two.id).phase, "queued");
	action(manager, two, "pause");
	unblock();
	await settle(manager, one.id);
	assert.equal((await settle(manager, three.id)).phase, "awaiting_user");
	assert.equal(manager.get(two.id).paused, true);
	action(manager, two, "resume");
	assert.equal((await settle(manager, two.id)).phase, "awaiting_user");
});

test("shutdown preserves an interrupted operation and restart resumes the stored session safely", async (t) => {
	let first = true;
	const context = fixture(t, async (_agent, options) => {
		if (first) {
			first = false;
			await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
		}
	});
	const run = context.manager.create({ task: "Plan" });
	const operation = context.manager.get(run.id).operations.codex.id;
	await context.manager.close();
	const recovered = new Collaboration(context.cwd, { directory: path.join(context.root, "state"), runner: context.manager.runner });
	t.after(() => recovered.close());
	assert.equal(recovered.get(run.id).phase, "needs_attention");
	assert.equal(recovered.get(run.id).operations.codex.id, operation);
	action(recovered, run, "resume");
	assert.equal((await settle(recovered, run.id)).phase, "awaiting_user");
});

test("a question while the plan waits for approval keeps the plan and votes", async (t) => {
	const { manager, calls } = fixture(t);
	let run = await settle(manager, manager.create({ task: "Plan a change" }).id);
	const before = calls.length;
	const revision = run.planRevision;
	action(manager, run, "message", { recipient: "both", content: "Why this approach?" });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "awaiting_user");
	assert.equal(run.planRevision, revision);
	assert.equal(run.planVotes.codex.revision, revision);
	assert.deepEqual(calls.slice(before).map((call) => call.phase), ["chat", "chat"]);
	action(manager, run, "approve", { planRevision: revision });
	assert.equal((await settle(manager, run.id)).phase, "completed");
});

test("a message marked as a task change revises and re-reviews the plan", async (t) => {
	const { manager, calls } = fixture(t);
	let run = await settle(manager, manager.create({ task: "Plan a change" }).id);
	const before = calls.length;
	action(manager, run, "message", { recipient: "codex", content: "Also update the docs.", change: true });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "awaiting_user");
	assert.deepEqual(calls.slice(before).map((call) => call.phase), ["chat", "draft", "plan-review", "plan-review"]);
	assert.equal(run.messages.find((message) => message.content === "Also update the docs.").change, true);
});

test("both agents answer a shared question at the same time", async (t) => {
	let started = 0;
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const { manager } = fixture(t, async (_agent, options) => {
		if (options.phase !== "chat") return;
		started++;
		if (started === 2) release();
		await gate;
	});
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	action(manager, run, "message", { recipient: "both", content: "Status?" });
	const answered = await settle(manager, run.id);
	assert.equal(started, 2);
	assert.equal(answered.messages.filter((message) => message.phase === "chat").length, 2);
});

test("a verification command that cannot start is recorded as a failed check", async (t) => {
	const { manager } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything", maxRounds: 1,
		commands: [["duo-missing-check-tool"]] }).id);
	assert.equal(run.phase, "needs_attention");
	assert.equal(run.checks[0].status, "failed");
	assert.match(run.checks[0].output, /could not run/);
	assert.match(run.error, /round limit/);
});

test("batch-file checks are rejected when the task is created", { skip: process.platform !== "win32" }, async (t) => {
	const { manager, root } = fixture(t);
	const script = path.join(root, "check.cmd");
	fs.writeFileSync(script, "@echo off\r\n");
	assert.throws(() => manager.create({ task: "Implement", commands: [[script]] }), /npx/);
});

test("Claude progress is reported while the CLI streams its work", async () => {
	const progress = [];
	const lines = [
		{ type: "system", subtype: "init" },
		{ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(process.cwd(), "README.md") } }] } },
		{ type: "result", session_id: "streamed", modelUsage: { "claude-fixture": {} }, structured_output: { message: "Done", plan: "", verdict: "approve", blockingIssues: [] } }
	].map((line) => `${JSON.stringify(line)}\n`);
	const result = await runClaude(process.cwd(), {
		prompt: "Inspect", onProgress: (item) => progress.push(item.message),
		execute: async (_command, args, options) => {
			if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
			assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
			for (const line of lines) options.onOutput(line);
			return { status: 0, stderr: "", stdout: lines.join("") };
		}
	});
	assert.deepEqual(progress, ["Read README.md"]);
	assert.equal(result.session, "streamed");
	assert.equal(result.model, "claude-fixture");
});

test("records saved by the previous version load with the new operation fields", async (t) => {
	const context = fixture(t);
	const run = await settle(context.manager, context.manager.create({ task: "Plan" }).id);
	const file = path.join(context.root, "state", `${run.id}.json`);
	const stored = JSON.parse(fs.readFileSync(file, "utf8"));
	delete stored.operations;
	delete stored.passes;
	delete stored.done;
	Object.assign(stored, { operation: null, modelPassCount: 0, modelPassPhase: null, cursor: 0, queue: [{ content: "Old question", recipients: ["claude"], chatOnly: false }] });
	fs.writeFileSync(file, JSON.stringify(stored));
	const loaded = context.manager.get(run.id);
	assert.deepEqual(loaded.operations, {});
	assert.deepEqual(loaded.done, []);
	assert.equal(loaded.queue[0].change, true);
	assert.equal(Object.hasOwn(loaded, "operation"), false);
});

test("workspace revisions include the state of Git submodules", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-submodule-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = (cwd, ...args) => assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, windowsHide: true }).status, 0, args.join(" "));
	const inner = path.join(root, "inner");
	const outer = path.join(root, "outer");
	fs.mkdirSync(inner);
	fs.mkdirSync(outer);
	git(inner, "init", "-q");
	fs.writeFileSync(path.join(inner, "a.txt"), "a\n");
	git(inner, "add", ".");
	git(inner, "commit", "-qm", "inner");
	git(outer, "init", "-q");
	git(outer, "submodule", "add", "-q", inner, "inner");
	git(outer, "commit", "-qm", "outer");
	const before = workspaceRevision(outer);
	fs.writeFileSync(path.join(outer, "inner", "a.txt"), "changed\n");
	const modified = workspaceRevision(outer);
	assert.notEqual(modified, before);
	fs.writeFileSync(path.join(outer, "inner", "a.txt"), "another change\n");
	const edited = workspaceRevision(outer);
	assert.notEqual(edited, modified);
	fs.writeFileSync(path.join(outer, "inner", "untracked.txt"), "first\n");
	const untracked = workspaceRevision(outer);
	assert.notEqual(untracked, edited);
	fs.writeFileSync(path.join(outer, "inner", "untracked.txt"), "second\n");
	assert.notEqual(workspaceRevision(outer), untracked);
});

test("agents learn which files changed since their last turn", async (t) => {
	const prompts = [];
	const { manager } = fixture(t, (agent, options) => { prompts.push({ agent, phase: options.phase, prompt: options.prompt }); });
	await settle(manager, manager.create({ task: "Implement", mode: "skip-everything" }).id);
	const planReview = prompts.find((entry) => entry.agent === "claude" && entry.phase === "plan-review");
	assert.match(planReview.prompt, /none changed since your last turn/);
	const review = prompts.find((entry) => entry.agent === "claude" && entry.phase === "review");
	assert.match(review.prompt, /changed since your last turn: `result\.txt`/);
	const first = prompts.find((entry) => entry.agent === "claude" && entry.phase === "proposal");
	assert.doesNotMatch(first.prompt, /Project files/);
});

test("project notes are saved and offered to the next conversation", async (t) => {
	const prompts = [];
	const { manager, cwd } = fixture(t, (agent, options) => {
		prompts.push({ agent, phase: options.phase, prompt: options.prompt });
		if (agent === "codex" && options.phase === "proposal") {
			return { response: { message: "Proposal", plan: "", verdict: "approve", blockingIssues: [], notes: "The server entry point is server.rs." }, session: "codex-session" };
		}
	});
	await settle(manager, manager.create({ task: "Plan a change" }).id);
	assert.equal(manager.store.readNotes().codex.text, "The server entry point is server.rs.");
	fs.appendFileSync(path.join(cwd, "README.md"), "More\n");
	prompts.length = 0;
	await settle(manager, manager.create({ task: "Another change" }).id);
	const first = prompts.find((entry) => entry.agent === "claude" && entry.phase === "proposal");
	assert.match(first.prompt, /Project notes from earlier conversations/);
	assert.match(first.prompt, /The server entry point is server\.rs\./);
	assert.match(first.prompt, /files changed since then: `README\.md`/);
});

test("a stop message recognizes only a whole-message stop request", () => {
	for (const text of ["stop", " STOP! ", "Stop everything.", "Oprește tot!", "opriti"]) assert.equal(isStopRequest(text), true, text);
	for (const text of ["stop using var", "don't stop", "oprește serverul", ""]) assert.equal(isStopRequest(text), false, text);
});

test("a stop message interrupts the active turn at once and leaves the run resumable", async (t) => {
	let blocking = true;
	const prompts = [];
	const { manager, calls } = fixture(t, async (_agent, options) => {
		prompts.push(options.prompt);
		if (!blocking) return;
		await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
	});
	const run = manager.create({ task: "Plan" });
	action(manager, run, "message", { recipient: "codex", content: "Oprește tot!" });
	let stopped = await settle(manager, run.id);
	assert.equal(stopped.paused, true);
	assert.equal(stopped.phase, "discussing");
	assert.equal(stopped.error, null);
	assert.deepEqual(stopped.operations, {});
	assert.deepEqual(stopped.queue, []);
	assert.equal(stopped.messages.at(-1).halt, true);
	assert.ok(stopped.events.some((event) => event.type === "halted"));
	assert.ok(!calls.some((call) => call.phase === "chat"));
	blocking = false;
	prompts.length = 0;
	action(manager, stopped, "resume");
	stopped = await settle(manager, run.id);
	assert.equal(stopped.phase, "awaiting_user");
	assert.ok(prompts.length > 0);
	assert.ok(prompts.every((prompt) => !prompt.includes("Oprește tot!")));
});

test("a stop message during implementation sends the interrupted work to verification on resume", async (t) => {
	const { manager } = fixture(t, async (_agent, options) => {
		if (!options.write) return;
		await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
	});
	const run = manager.create({ task: "Create result.txt", mode: "skip-everything" });
	while (!Object.values(manager.get(run.id).operations).some((operation) => operation.write)) await new Promise((resolve) => setTimeout(resolve, 10));
	action(manager, run, "message", { recipient: "both", content: "stop" });
	const stopped = await settle(manager, run.id);
	assert.equal(stopped.paused, true);
	assert.equal(stopped.phase, "implementing");
	assert.equal(stopped.stage, "verify");
	assert.deepEqual(stopped.operations, {});
});

test("a stop message on an ended run changes nothing", async (t) => {
	const { manager } = fixture(t, async (_agent, options) => {
		await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
	});
	const run = manager.create({ task: "Plan" });
	action(manager, run, "cancel");
	const cancelled = await settle(manager, run.id);
	const count = cancelled.messages.length;
	action(manager, cancelled, "message", { recipient: "both", content: "stop" });
	assert.equal(manager.get(run.id).phase, "cancelled");
	assert.equal(manager.get(run.id).messages.length, count);
});

test("Claude gets a shell only when it may write", () => {
	assert.equal(claudeTools(false), "Read,Glob,Grep");
	const shell = process.platform === "win32" ? "Bash,PowerShell" : "Bash";
	assert.equal(claudeTools(true), `Read,Glob,Grep,Edit,Write,${shell}`);
	assert.equal(describeCommand("npm   test\n -- --watch=false"), "Running command: npm test -- --watch=false");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { validateResponse } from "../plugins/codex/scripts/lib/collaboration-protocol.mjs";
import { runClaude } from "../plugins/codex/scripts/lib/claude.mjs";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";
import { RemoteAgentRunner } from "../plugins/codex/scripts/lib/collaboration-remote.mjs";

function response(routing = null, extra = {}) {
	return { response: { message: "Reviewed synthetic fixture", plan: "# Plan\nInspect the fixture.", verdict: "approve", blockingIssues: [], routing, ...extra } };
}

test("each participant can choose its own next model while preserving sessions and read-only phases", async (t) => {
	const selected = { codex: "gpt-fixture-economy", claude: "haiku" };
	const { manager, calls } = fixture(t, (agent, options) => {
		if (options.phase === "proposal" && !options.model) return response({ model: selected[agent], repeat: true, reason: "Use a smaller model for this inspection." });
		return { ...response(), model: `reported-${agent}` };
	});
	const run = await settle(manager, manager.create({ task: "Plan the fixture" }).id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(run.modelPolicy, "adaptive");
	for (const agent of ["codex", "claude"]) {
		const proposals = calls.filter((call) => call.agent === agent && call.phase === "proposal");
		assert.deepEqual(proposals.map((call) => call.model), [null, selected[agent]]);
		assert.equal(proposals[1].session, `${agent}-session`);
		assert.notEqual(proposals[0].operationId, proposals[1].operationId);
		assert.equal(run.activeModels[agent], selected[agent]);
		assert.equal(run.models[agent], `reported-${agent}`);
		assert.ok(run.modelHistory.some((entry) => entry.agent === agent && entry.requested === selected[agent] && entry.reported === `reported-${agent}`));
	}
	assert.ok(calls.every((call) => !call.write));
	assert.equal(run.events.filter((event) => event.type === "model-selection").length, 2);
});

test("an agent can make ten justified passes without forcing ten passes in other phases", async (t) => {
	let passes = 0;
	const { manager, calls } = fixture(t, (agent, options) => {
		if (agent !== "codex" || options.phase !== "proposal") return;
		passes++;
		return response({ model: "gpt-fixture-economy", repeat: passes < 10, reason: "Check another fixture acceptance case." });
	});
	const run = await settle(manager, manager.create({ task: "Inspect several cases" }).id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(passes, 10);
	assert.equal(calls.filter((call) => call.agent === "claude" && call.phase === "proposal").length, 1);
	assert.equal(calls.filter((call) => call.phase === "draft").length, 1);
	assert.equal(run.messages.filter((message) => message.provisional).length, 9);
});

test("a model choice for a later phase does not force a repeat", async (t) => {
	const { manager, calls } = fixture(t, (agent, options) => {
		if (agent === "codex" && options.phase === "proposal") return response({ model: "gpt-fixture-review", repeat: false, reason: "Use a stronger model for plan synthesis." });
	});
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(calls.filter((call) => call.agent === "codex" && call.phase === "proposal").length, 1);
	assert.equal(calls.find((call) => call.phase === "draft").model, "gpt-fixture-review");
});

test("repeated provisional approvals cannot bypass the pass limit", async (t) => {
	const { manager, calls } = fixture(t, () => response({ model: null, repeat: true, reason: "Another inspection." }));
	const run = await settle(manager, manager.create({ task: "Plan", maxPasses: 2 }).id);
	assert.equal(run.phase, "needs_attention");
	assert.match(run.error, /pass limit/);
	assert.deepEqual(calls.map((call) => call.agent).sort(), ["claude", "claude", "codex", "codex"]);
	assert.deepEqual(run.planVotes, {});
	assert.deepEqual(run.votes, {});
});

test("fixed selection ignores model requests and invalid routing cannot change models", async (t) => {
	const { manager, calls } = fixture(t, () => response({ model: "gpt-fixture-other", repeat: false, reason: "Switch models." }));
	const run = await settle(manager, manager.create({ task: "Plan", modelPolicy: "fixed", codexModel: "gpt-fixture-fixed" }).id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(run.activeModels.codex, "gpt-fixture-fixed");
	assert.ok(calls.filter((call) => call.agent === "codex").every((call) => call.model === "gpt-fixture-fixed"));
	assert.ok(run.events.some((event) => event.type === "model-request-ignored" && event.model === "gpt-fixture-other"));
	for (const model of ["https://example.invalid", "--override", "a;echo", "/tmp/model", "", 17]) {
		assert.throws(() => validateResponse(response({ model, repeat: true, reason: "Invalid fixture" }).response), /invalid model-routing/);
	}
	assert.throws(() => manager.create({ task: "Plan", codexModel: "https://example.invalid" }), /model identifier/);
	assert.throws(() => manager.create({ task: "Plan", maxPasses: 31 }), /Pass limit/);
});

test("an unavailable chosen model stops without automatically retrying or changing provider", async (t) => {
	const { manager, calls } = fixture(t, (_agent, options) => {
		if (options.model) throw new Error("Requested fixture model is unavailable");
		return response({ model: "gpt-fixture-unavailable", repeat: true, reason: "Try another supported model." });
	});
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	assert.equal(run.phase, "needs_attention");
	assert.equal(calls.length, 4);
	assert.equal(run.operations.codex.model, "gpt-fixture-unavailable");
	assert.deepEqual(run.votes, {});
});

test("repeated implementation stays with the owner and verification follows its final pass", async (t) => {
	let passes = 0;
	const { manager, cwd, calls } = fixture(t, (_agent, options) => {
		if (!options.write) return;
		passes++;
		fs.writeFileSync(path.join(options.cwd, "result.txt"), String(passes));
		return response({ model: "gpt-fixture-implementation", repeat: passes < 2, reason: "Complete the next implementation step." });
	});
	const run = await settle(manager, manager.create({ task: "Implement two steps", mode: "skip-everything", commands: [[process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'2')"]] }).id);
	assert.equal(run.phase, "completed", run.error);
	assert.equal(run.checks[0].status, "passed");
	assert.equal(fs.readFileSync(path.join(cwd, "result.txt"), "utf8"), "2");
	assert.deepEqual(calls.filter((call) => call.write).map((call) => call.agent), ["codex", "codex"]);
	assert.equal(run.votes.codex.revision, run.votes.claude.revision);
});

test("pause interrupts additional-pass scheduling and resume preserves the next model", async (t) => {
	let paused = false;
	const { manager, calls } = fixture(t, (_agent, options) => {
		if (paused) return;
		paused = true;
		manager.action(options.run.id, "pause", { requestId: randomUUID() });
		return response({ model: "gpt-fixture-economy", repeat: true, reason: "Continue after the user's pause." });
	});
	let run = await settle(manager, manager.create({ task: "Plan" }).id);
	assert.equal(run.paused, true);
	assert.equal(calls.length, 2);
	manager.action(run.id, "resume", { requestId: randomUUID() });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(calls.filter((call) => call.agent === calls[0].agent)[1].model, "gpt-fixture-economy");
});

test("Claude uses the CLI default initially and an explicit chosen model with the same restricted tools", async () => {
	for (const model of [null, "haiku", "opus"]) {
		let invocation;
		await runClaude(process.cwd(), { prompt: "Inspect a synthetic fixture", model, session: "fixture-session", write: false,
			execute: async (_command, args) => {
				if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
				invocation = args;
				return { status: 0, stdout: JSON.stringify({ session_id: "fixture-session", structured_output: response().response }) };
			}
		});
		assert.equal(invocation.includes("--model"), model !== null);
		if (model) assert.equal(invocation[invocation.indexOf("--model") + 1], model);
		assert.equal(invocation[invocation.indexOf("--tools") + 1], "Read,Glob,Grep");
		assert.equal(invocation[invocation.indexOf("--resume") + 1], "fixture-session");
	}
});

test("a provisional final approval cannot replace a later blocking verdict", async (t) => {
	let passes = 0;
	const { manager } = fixture(t, (agent, options) => {
		if (agent !== "codex" || options.phase !== "review") return;
		passes++;
		if (passes === 1) return response({ model: "gpt-fixture-review", repeat: true, reason: "Check one more acceptance case before voting." });
		return response(null, { verdict: "blocked", blockingIssues: ["Synthetic missing acceptance case"] });
	});
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything", maxRounds: 1 }).id);
	assert.equal(run.phase, "needs_attention");
	assert.equal(passes, 2);
	assert.equal(run.votes.codex.verdict, "blocked");
});

test("restart resumes the checkpointed model and operation rather than selecting or replaying a new operation", async (t) => {
	let notify;
	const started = new Promise((resolve) => { notify = resolve; });
	const { manager, cwd, root } = fixture(t, async (_agent, options) => {
		if (!options.model) return response({ model: "gpt-fixture-resumed", repeat: true, reason: "Continue the fixture inspection." });
		notify();
		await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
	});
	const created = manager.create({ task: "Plan with a checkpoint" });
	await started;
	const operationId = manager.get(created.id).operations.codex.id;
	await manager.close();
	let resumed;
	const restarted = new Collaboration(cwd, { directory: path.join(root, "state"), runner: { async call(agent, options) {
		resumed ??= { model: options.model, operationId: options.operationId };
		return { ...response(), session: `${agent}-resumed` };
	} } });
	t.after(() => restarted.close());
	restarted.action(created.id, "resume", { requestId: randomUUID() });
	const run = await settle(restarted, created.id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(resumed.model, "gpt-fixture-resumed");
	assert.equal(resumed.operationId, operationId);
	assert.equal(run.modelHistory.filter((entry) => entry.operationId === operationId).length, 1);
});

test("the remote adapter forwards a chosen model without widening remote permissions", async () => {
	const runner = new RemoteAgentRunner();
	runner.prepare = async () => ({ base: "fixture-base", cwd: "/fixture/remote" });
	let request;
	runner.wait = async (_options, input) => { request = input; return response(); };
	await runner.call("claude", { cwd: "/fixture/local", model: "haiku", session: "fixture-session", write: false,
		prompt: "Workspace: /fixture/local", run: { id: "fixture-run", mode: "split", remoteAgent: "claude" } });
	assert.equal(request.model, "haiku");
	assert.equal(request.write, false);
	assert.equal(request.agent, "claude");
	assert.equal(request.session, "fixture-session");
	assert.match(request.prompt, /Workspace: \/fixture\/remote/);
});

test("the chosen reasoning effort reaches both agents and the Claude command line", async (t) => {
	const { manager, calls } = fixture(t, (_agent, options) => { calls.at(-1).effort = options.effort; });
	const run = await settle(manager, manager.create({ task: "Plan", effort: "low" }).id);
	assert.equal(run.effort, "low");
	assert.ok(calls.every((call) => call.effort === "low"));
	assert.throws(() => manager.create({ task: "Plan", effort: "extreme" }), /low, medium, or high/);
	let args;
	await runClaude(process.cwd(), { prompt: "Inspect", effort: "low", execute: async (_command, values) => {
		if (values[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
		args = values;
		return { status: 0, stdout: JSON.stringify({ type: "result", session_id: "s", structured_output: response().response }) };
	} });
	assert.equal(args[args.indexOf("--effort") + 1], "low");
});

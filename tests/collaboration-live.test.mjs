import test from "node:test";
import assert from "node:assert/strict";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { RemoteAgentRunner } from "../plugins/codex/scripts/lib/collaboration-remote.mjs";

test("live subscription sessions exchange opinions and jointly review a Medium plan", { skip: process.env.DUO_LIVE_TEST !== "1", timeout: 240000 }, async (t) => {
	const { manager } = fixture(t);
	manager.runner = new RemoteAgentRunner();
	const run = await settle(manager, manager.create({
		task: "Propose a minimal documentation-only plan to add a one-sentence project description to README.md. Do not implement it.",
		criteria: "The proposed change affects README.md only and does not change runtime behavior. A short plan with a manual verification step is sufficient.",
		codexModel: "gpt-6-luna", maxRounds: 2
	}).id);
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.equal(run.planVotes.codex.verdict, "approve");
	assert.equal(run.planVotes.claude.verdict, "approve");
	assert.ok(run.sessions.codex);
	assert.ok(run.sessions.claude);
	assert.ok(run.messages.some((message) => message.sender === "codex"));
	assert.ok(run.messages.some((message) => message.sender === "claude"));
});

test("live Skip everything implements a small task and obtains both final approvals", { skip: process.env.DUO_LIVE_WRITE_TEST !== "1", timeout: 300000 }, async (t) => {
	const { manager } = fixture(t);
	manager.runner = new RemoteAgentRunner();
	const run = await settle(manager, manager.create({
		task: "Create result.txt containing exactly Duo verified followed by a newline. Change no other project files. Do not commit.",
		criteria: "result.txt exists with that exact content; all existing files remain unchanged. No runtime feature is required.",
		mode: "skip-everything", codexModel: "gpt-6-luna", maxRounds: 2,
		commands: [[process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'Duo verified\\n')"]]
	}).id);
	assert.equal(run.phase, "completed", run.error);
	assert.equal(run.checks[0].status, "passed");
	assert.equal(run.votes.codex.verdict, "approve");
	assert.equal(run.votes.claude.verdict, "approve");
	assert.equal(run.votes.codex.revision, run.votes.claude.revision);
});

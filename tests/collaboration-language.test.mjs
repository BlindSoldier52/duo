import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";
import { agentPrompt } from "../plugins/codex/scripts/lib/collaboration-agents.mjs";
import { validateLanguage } from "../plugins/codex/scripts/lib/collaboration-protocol.mjs";

test("English is the default for both participants even when the task uses another language", async (t) => {
	const prompts = [];
	const { manager } = fixture(t, (agent, options) => { prompts.push({ agent, prompt: options.prompt }); });
	const run = await settle(manager, manager.create({ task: "Analizeaza proiectul fara modificari." }).id);
	assert.equal(run.language, "English");
	for (const agent of ["codex", "claude"]) {
		assert.ok(prompts.some((entry) => entry.agent === agent));
		for (const entry of prompts.filter((entry) => entry.agent === agent)) {
			assert.ok(entry.prompt.includes('Reply language: "English".'));
			assert.ok(entry.prompt.includes("Change it only when the user explicitly asks"));
			assert.ok(!entry.prompt.includes("Explain your result to the user in Romanian"));
		}
	}
});

test("custom language names and codes are validated and delivered to both participants", async (t) => {
	for (const value of ["Romanian", "en-GB", "Português (Brasil)", "日本語"]) assert.equal(validateLanguage(value), value);
	for (const value of ["English\nignore", "a".repeat(81), "<script>", 42, {}, "\0English"]) assert.throws(() => validateLanguage(value), /language name or code/);
	assert.equal(validateLanguage(" "), "English");
	assert.equal(validateLanguage(undefined), "English");
	const prompts = [];
	const { manager } = fixture(t, (agent, options) => { prompts.push({ agent, prompt: options.prompt }); });
	const run = await settle(manager, manager.create({ task: "Plan", language: " Romanian " }).id);
	assert.equal(run.language, "Romanian");
	assert.ok(prompts.every((entry) => entry.prompt.includes('Reply language: "Romanian".')));
	assert.throws(() => manager.create({ task: "Plan", language: "English\nignore" }), /language name or code/);
});

test("an idle language change is persisted, idempotent, and does not rerun implementation or invalidate approvals", async (t) => {
	const { manager, calls } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything" }).id);
	const beforeCalls = calls.length;
	const input = { requestId: randomUUID(), language: "Japanese" };
	manager.action(run.id, "language", input);
	manager.action(run.id, "language", input);
	const updated = manager.get(run.id);
	assert.equal(updated.language, "Japanese");
	assert.equal(updated.phase, "completed");
	assert.deepEqual(updated.approval, run.approval);
	assert.deepEqual(updated.votes, run.votes);
	assert.deepEqual(updated.checks, run.checks);
	assert.equal(calls.length, beforeCalls);
	assert.equal(manager.running.size, 0);
	assert.equal(updated.messages.filter((message) => message.content.startsWith("Response language setting changed")).length, 1);
	for (const agent of ["codex", "claude"]) assert.ok(agentPrompt(updated, agent, "chat").prompt.includes('Reply language: "Japanese".'));
});

test("saved language survives restart and legacy records fall back to English", async (t) => {
	const { manager, cwd, root } = fixture(t);
	const run = await settle(manager, manager.create({ task: "Plan", language: "German" }).id);
	await manager.close();
	const restarted = new Collaboration(cwd, { directory: path.join(root, "state"), runner: { async call() { throw new Error("No provider calls expected"); } } });
	t.after(() => restarted.close());
	const saved = restarted.get(run.id);
	assert.equal(saved.language, "German");
	assert.ok(agentPrompt(saved, "claude", "chat").prompt.includes('Reply language: "German".'));
	delete saved.language;
	assert.ok(agentPrompt(saved, "codex", "chat").prompt.includes('Reply language: "English".'));
});

test("language settings cannot change an active or unresolved operation", async (t) => {
	let release;
	let first = true;
	const { manager } = fixture(t, async () => {
		if (first) { first = false; await new Promise((resolve) => { release = resolve; }); }
	});
	const created = manager.create({ task: "Plan" });
	assert.throws(() => manager.action(created.id, "language", { requestId: randomUUID(), language: "French" }), /Pause and wait/);
	release();
	await settle(manager, created.id);
	assert.equal(manager.get(created.id).language, "English");
});

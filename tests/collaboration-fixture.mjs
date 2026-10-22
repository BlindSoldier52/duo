import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";

export function fixture(t, behavior, options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-test-"));
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	for (const args of options.git === false ? [] : [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) {
		assert.equal(spawnSync("git", args, { cwd, windowsHide: true }).status, 0);
	}
	fs.writeFileSync(path.join(cwd, "README.md"), "Fixture project\n");
	fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
	if (options.git !== false) {
		assert.equal(spawnSync("git", ["add", "."], { cwd, windowsHide: true }).status, 0);
		assert.equal(spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "Initial"], { cwd, windowsHide: true }).status, 0);
	}
	const calls = [];
	const runner = {
		async call(agent, options) {
			calls.push({ agent, phase: options.phase, write: options.write, session: options.session, model: options.model, operationId: options.operationId });
			options.onSession?.({ session: `${agent}-session`, model: `${agent}-reported` });
			if (behavior) {
				const result = await behavior(agent, options, calls);
				if (result) return result;
			}
			if (options.write) fs.writeFileSync(path.join(cwd, "result.txt"), "implemented\n");
			return { response: { message: `${agent} reviewed ${options.phase}`, plan: "# Plan\n\nImplement result.txt and verify it.", verdict: "approve", blockingIssues: [] }, session: `${agent}-session` };
		}
	};
	const manager = new Collaboration(cwd, { directory: path.join(root, "state"), runner });
	t.after(async () => { await manager.close(); });
	return { root, cwd, manager, calls };
}

export async function settle(manager, id) {
	await manager.running.get(id)?.promise;
	return manager.get(id);
}

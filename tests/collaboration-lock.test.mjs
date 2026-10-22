import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { fixture } from "./collaboration-fixture.mjs";
import { CollaborationStore } from "../plugins/codex/scripts/lib/collaboration-state.mjs";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";
import { startWeb } from "../plugins/codex/scripts/lib/web-server.mjs";

const entry = fileURLToPath(new URL("../duo.mjs", import.meta.url));

test("a second coordinator fails immediately without stealing an old but live ownership lock", (t) => {
	const { cwd, root } = fixture(t);
	const directory = path.join(root, "state");
	const lock = path.join(directory, "coordinator.lock");
	const sinceBoot = new Date(Date.now() - os.uptime() * 1000 + 5000);
	fs.utimesSync(lock, sinceBoot, sinceBoot);
	assert.throws(() => new CollaborationStore(cwd, directory), (error) => {
		assert.equal(error.code, "DUO_ALREADY_RUNNING");
		assert.equal(error.status, 409);
		assert.match(error.message, /Duo is already running for this workspace/);
		assert.doesNotMatch(error.message, /Timed out/);
		assert.equal(error.cause.code, "LOCK_BUSY");
		return true;
	});
	assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("a lock written before the last boot is stale even when its process ID is in use again", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-lock-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const lock = path.join(root, "coordinator.lock");
	fs.writeFileSync(lock, String(process.ppid));
	const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 120000);
	fs.utimesSync(lock, beforeBoot, beforeBoot);
	const store = new CollaborationStore(root, root);
	t.after(() => store.close());
	assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("a lock held by a live process that is not Node.js is treated as stale", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-lock-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const other = spawn(process.platform === "win32" ? "cmd.exe" : "sleep", process.platform === "win32" ? ["/c", "ping -n 30 127.0.0.1 >nul"] : ["30"], { stdio: "ignore", windowsHide: true });
	t.after(() => other.kill());
	const lock = path.join(root, "coordinator.lock");
	fs.writeFileSync(lock, String(other.pid));
	const store = new CollaborationStore(root, root);
	t.after(() => store.close());
	assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("a second web or standalone CLI process exits unsuccessfully without replacing the running coordinator", async (t) => {
	const { cwd } = fixture(t);
	const owner = new Collaboration(cwd);
	const app = await startWeb({ cwd, manager: owner, port: 0 });
	t.after(() => app.close());
	for (const args of [["web", "--port", "0"], ["web", "--port", "3211"], ["collaborate", "status"]]) {
		const result = spawnSync(process.execPath, [entry, ...args, "--cwd", cwd], { cwd, encoding: "utf8", windowsHide: true, timeout: 10000 });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Duo is already running for this workspace/);
		assert.doesNotMatch(result.stderr, /Timed out waiting for lock/);
		assert.equal(result.stdout, "");
		assert.equal(fs.readFileSync(path.join(owner.store.directory, "coordinator.lock"), "utf8"), String(process.pid));
	}
	assert.equal((await fetch(app.url)).status, 200);
});

test("an abandoned ownership lock is recovered when its holder has exited", (t) => {
	const { cwd, root } = fixture(t);
	const directory = path.join(root, "abandoned-state");
	fs.mkdirSync(directory);
	const holder = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
	assert.equal(holder.status, 0);
	const lock = path.join(directory, "coordinator.lock");
	fs.writeFileSync(lock, holder.stdout);
	const store = new CollaborationStore(cwd, directory);
	t.after(() => store.close());
	assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
	store.close();
	assert.equal(fs.existsSync(lock), false);
});

test("closing the owner permits a replacement while separate workspaces remain independent", (t) => {
	const first = fixture(t);
	const second = fixture(t);
	const a = new CollaborationStore(first.cwd);
	const b = new CollaborationStore(second.cwd);
	t.after(() => a.close());
	t.after(() => b.close());
	assert.notEqual(a.directory, b.directory);
	a.close();
	const replacement = new CollaborationStore(first.cwd);
	t.after(() => replacement.close());
	assert.equal(fs.readFileSync(path.join(b.directory, "coordinator.lock"), "utf8"), String(process.pid));
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./collaboration-fixture.mjs";
import { snapshot, bundle, receiveBundle, applySnapshot, git } from "../plugins/codex/scripts/lib/collaboration-git.mjs";
import { remoteRequest } from "../plugins/codex/scripts/remote-worker.mjs";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";

test("VPS tasks reject Git subdirectories before provider calls or snapshot creation", async (t) => {
	const { cwd, root, manager: parent, calls } = fixture(t);
	const selected = path.join(cwd, "selected");
	fs.mkdirSync(selected);
	fs.writeFileSync(path.join(selected, "inside.txt"), "Selected workspace\n");
	const manager = new Collaboration(selected, {
		directory: path.join(root, "selected-state"),
		runner: { ...parent.runner, validateRemote() {} }
	});
	t.after(() => manager.close());
	const before = git(cwd, ["status", "--porcelain"]);
	const checkpoint = snapshot(cwd, "refs/duo/audit/local");
	assert.throws(() => manager.create({ task: "Implement", mode: "split", policy: "medium" }), /requires the Git repository root/);
	assert.throws(() => snapshot(selected, "refs/duo/audit/subdirectory"), /requires the Git repository root/);
	assert.throws(() => bundle(selected, checkpoint), /requires the Git repository root/);
	await assert.rejects(remoteRequest(selected, { action: "prepare", runId: randomUUID() }), /requires the Git repository root/);
	assert.deepEqual(calls, []);
	assert.deepEqual(manager.list(), []);
	assert.equal(git(cwd, ["status", "--porcelain"]), before);
	assert.equal(git(cwd, ["for-each-ref", "refs/duo/audit/subdirectory"]), "");
	const local = manager.create({ task: "Plan locally" });
	await manager.running.get(local.id)?.promise;
	assert.equal(manager.get(local.id).phase, "awaiting_user");
	assert.ok(calls.length > 0);
	assert.ok(calls.every((call) => !call.write));
});

test("Git snapshots preserve the user's real index and transfer uncommitted files", (t) => {
	const local = fixture(t);
	const remote = fixture(t);
	const id = randomUUID();
	fs.appendFileSync(path.join(local.cwd, "README.md"), "User changes\n");
	fs.writeFileSync(path.join(local.cwd, "new.txt"), "Uncommitted content\n");
	const before = git(local.cwd, ["status", "--porcelain"]);
	const checkpoint = snapshot(local.cwd, `refs/duo/${id}/local`);
	assert.equal(git(local.cwd, ["status", "--porcelain"]), before);
	assert.equal(git(local.cwd, ["diff", "--cached"]), "");
	const revision = receiveBundle(remote.cwd, bundle(local.cwd, checkpoint), `refs/duo/${id}/input`);
	git(remote.cwd, ["checkout", "--detach", revision]);
	assert.equal(fs.readFileSync(path.join(remote.cwd, "new.txt"), "utf8").replace(/\r\n/g, "\n"), "Uncommitted content\n");
	assert.match(fs.readFileSync(path.join(remote.cwd, "README.md"), "utf8"), /User changes/);
});

test("remote changes including binary files apply once without committing the local workspace", (t) => {
	const local = fixture(t);
	const remote = fixture(t);
	const id = randomUUID();
	const initialHead = git(local.cwd, ["rev-parse", "HEAD"]);
	const base = snapshot(local.cwd, `refs/duo/${id}/local`);
	const imported = receiveBundle(remote.cwd, bundle(local.cwd, base), `refs/duo/${id}/input`);
	git(remote.cwd, ["checkout", "--detach", imported]);
	fs.writeFileSync(path.join(remote.cwd, "binary.dat"), Buffer.from([0, 255, 1, 2, 0]));
	fs.appendFileSync(path.join(remote.cwd, "README.md"), "Remote result\n");
	const output = bundle(remote.cwd, snapshot(remote.cwd, `refs/duo/${id}/output`));
	applySnapshot(local.cwd, base.revision, output, id);
	applySnapshot(local.cwd, base.revision, output, id);
	assert.deepEqual(fs.readFileSync(path.join(local.cwd, "binary.dat")), Buffer.from([0, 255, 1, 2, 0]));
	assert.match(fs.readFileSync(path.join(local.cwd, "README.md"), "utf8"), /Remote result/);
	assert.equal(git(local.cwd, ["rev-parse", "HEAD"]), initialHead);
});

test("remote integration refuses to overwrite concurrent user edits", (t) => {
	const local = fixture(t);
	const remote = fixture(t);
	const id = randomUUID();
	const base = snapshot(local.cwd, `refs/duo/${id}/local`);
	receiveBundle(remote.cwd, bundle(local.cwd, base), `refs/duo/${id}/input`);
	fs.appendFileSync(path.join(remote.cwd, "README.md"), "Remote change\n");
	const output = bundle(remote.cwd, snapshot(remote.cwd, `refs/duo/${id}/output`));
	fs.appendFileSync(path.join(local.cwd, "README.md"), "Concurrent user change\n");
	assert.throws(() => applySnapshot(local.cwd, base.revision, output, id), /Local workspace changed/);
	assert.match(fs.readFileSync(path.join(local.cwd, "README.md"), "utf8"), /Concurrent user change/);
});

test("remote worker prepares owned worktrees and persists idempotent background verification", async (t) => {
	const local = fixture(t);
	const remote = fixture(t);
	const runId = randomUUID();
	const id = randomUUID();
	const prepared = await remoteRequest(remote.cwd, { action: "prepare", runId, bundle: bundle(local.cwd, snapshot(local.cwd, `refs/duo/${runId}/local`)) });
	assert.notEqual(prepared.cwd, remote.cwd);
	assert.equal(fs.readFileSync(path.join(prepared.cwd, "README.md"), "utf8").replace(/\r\n/g, "\n"), "Fixture project\n");
	const request = { runId, kind: "verify", commands: [[process.execPath, "-e", "console.log('verified')"]], write: false };
	await remoteRequest(remote.cwd, { action: "start", id, request });
	await remoteRequest(remote.cwd, { action: "start", id, request });
	await assert.rejects(remoteRequest(remote.cwd, { action: "start", id, request: { ...request, commands: [] } }), /reused/);
	const deadline = Date.now() + 15000;
	let state;
	do {
		await new Promise((resolve) => setTimeout(resolve, 100));
		state = await remoteRequest(remote.cwd, { action: "status", id });
	} while (["starting", "running"].includes(state.status) && Date.now() < deadline);
	assert.equal(state.status, "completed", state.error);
	assert.equal(state.result.checks[0].status, "passed");
	assert.match(state.result.checks[0].output, /verified/);
});

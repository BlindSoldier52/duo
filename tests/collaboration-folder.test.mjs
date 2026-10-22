import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { Collaboration } from "../plugins/codex/scripts/lib/collaboration.mjs";
import { isGitWorkspace, workspaceSnapshot, workspaceRevision, workspaceDiff, projectFile } from "../plugins/codex/scripts/lib/collaboration-workspace.mjs";
import { startWeb } from "../plugins/codex/scripts/lib/web-server.mjs";

test("a folder without Git or package.json supports Medium, approval, verification, and both final votes", async (t) => {
	const { cwd, manager, calls } = fixture(t, null, { git: false });
	assert.equal(isGitWorkspace(cwd), false);
	let run = await settle(manager, manager.create({ task: "Implement result.txt", commands: [[process.execPath, "-e", "require('fs').accessSync('result.txt')"]] }).id);
	assert.equal(run.workspaceKind, "folder");
	assert.equal(run.phase, "awaiting_user", run.error);
	assert.ok(calls.every((call) => !call.write));
	manager.action(run.id, "approve", { requestId: randomUUID(), planRevision: run.planRevision });
	run = await settle(manager, run.id);
	assert.equal(run.phase, "completed", run.error);
	assert.equal(run.checks[0].status, "passed");
	assert.equal(run.votes.codex.revision, workspaceRevision(cwd));
	assert.equal(run.votes.claude.revision, run.votes.codex.revision);
	assert.match(manager.artifacts(run.id).status, /^A result\.txt$/m);
	assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
	assert.equal(fs.existsSync(path.join(cwd, "package.json")), false);
});

test("Skip everything works in a plain folder and its changes baseline survives restart", async (t) => {
	const { cwd, root, manager } = fixture(t, null, { git: false });
	const run = await settle(manager, manager.create({ task: "Implement", mode: "skip-everything" }).id);
	assert.equal(run.phase, "completed", run.error);
	await manager.close();
	const restarted = new Collaboration(cwd, { directory: path.join(root, "state") });
	t.after(() => restarted.close());
	assert.match(restarted.artifacts(run.id).status, /^A result\.txt$/m);
	assert.match(restarted.artifacts(run.id).diff, /Git history and unified diffs are unavailable/);
});

test("plain-folder revisions detect content changes even with preserved file sizes and timestamps", (t) => {
	const { cwd } = fixture(t, null, { git: false });
	const file = path.join(cwd, "README.md");
	const before = workspaceSnapshot(cwd);
	const stat = fs.statSync(file);
	fs.writeFileSync(file, "Changed project\n");
	fs.utimesSync(file, stat.atime, stat.mtime);
	assert.notEqual(workspaceRevision(cwd), before.revision);
	fs.writeFileSync(path.join(cwd, "new.bin"), Buffer.from([0, 255, 42]));
	fs.unlinkSync(path.join(cwd, ".gitignore"));
	const changes = workspaceDiff(cwd, before.files);
	assert.match(changes.status, /^M README\.md$/m);
	assert.match(changes.status, /^A new\.bin$/m);
	assert.match(changes.status, /^D \.gitignore$/m);
});

test("plain-folder user edits invalidate approval and read-only modifications stop the run", async (t) => {
	const { cwd, manager } = fixture(t, null, { git: false });
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	fs.appendFileSync(path.join(cwd, "README.md"), "User change\n");
	assert.throws(() => manager.action(run.id, "approve", { requestId: randomUUID(), planRevision: run.planRevision }), /Workspace changed/);
	const changed = fixture(t, (_agent, options) => {
		fs.appendFileSync(path.join(options.cwd, "README.md"), "Unexpected write\n");
	}, { git: false });
	const stopped = await settle(changed.manager, changed.manager.create({ task: "Inspect" }).id);
	assert.equal(stopped.phase, "needs_attention");
	assert.match(stopped.error, /read-only phase/);
});

test("folder scanning excludes credential paths and dependency directories without opening their contents", (t) => {
	const { cwd } = fixture(t, null, { git: false });
	const before = workspaceRevision(cwd);
	for (const name of [".env", ".env.local", ".npmrc", "id_ed25519", "private.pem", "secrets.json", ".ssh", "node_modules"]) {
		fs.mkdirSync(path.join(cwd, name));
		fs.writeFileSync(path.join(cwd, name, "synthetic.txt"), "Synthetic fixture, not a credential");
	}
	assert.equal(workspaceRevision(cwd), before);
	assert.throws(() => projectFile(cwd, ".npmrc/synthetic.txt"), /Credential files/);
});

test("folder scanning skips build output and detects large-file content changes with preserved metadata", (t) => {
	const { cwd } = fixture(t, null, { git: false });
	const before = workspaceRevision(cwd);
	for (const name of ["target", "dist", "build", "out", "obj"]) {
		fs.mkdirSync(path.join(cwd, "client", name), { recursive: true });
		fs.writeFileSync(path.join(cwd, "client", name, "artifact.bin"), "compiled output");
	}
	assert.equal(workspaceRevision(cwd), before);
	const large = path.join(cwd, "sounds.pak");
	fs.writeFileSync(large, Buffer.alloc(17 * 1024 * 1024, 1));
	const time = new Date("2026-01-01T00:00:00Z");
	fs.utimesSync(large, time, time);
	const withLarge = workspaceRevision(cwd);
	assert.notEqual(withLarge, before);
	const descriptor = fs.openSync(large, "r+");
	try { fs.writeSync(descriptor, Buffer.from([2]), 0, 1, 0); }
	finally { fs.closeSync(descriptor); }
	fs.utimesSync(large, time, time);
	const changed = workspaceRevision(cwd);
	assert.notEqual(changed, withLarge);
	fs.appendFileSync(large, "more");
	assert.notEqual(workspaceRevision(cwd), changed);
});

test("folder fingerprints do not traverse directory symlinks or read their target contents", (t) => {
	const { cwd, root } = fixture(t, null, { git: false });
	const target = path.join(root, "outside");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "synthetic.txt"), "Initial fixture");
	fs.symlinkSync(target, path.join(cwd, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
	const before = workspaceSnapshot(cwd);
	assert.ok(Object.hasOwn(before.files, "linked-directory"));
	assert.equal(Object.hasOwn(before.files, "linked-directory/synthetic.txt"), false);
	fs.writeFileSync(path.join(target, "synthetic.txt"), "Changed fixture");
	assert.equal(workspaceRevision(cwd), before.revision);
	assert.throws(() => projectFile(cwd, "linked-directory/synthetic.txt"), /outside the project/);
});

test("plain folders work without Git on PATH, and empty Git repositories do not need an initial commit locally", (t) => {
	const { cwd, root } = fixture(t, null, { git: false });
	const module = new URL("../plugins/codex/scripts/lib/collaboration-workspace.mjs", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const {workspaceSnapshot}=await import(${JSON.stringify(module)}); console.log(workspaceSnapshot(process.cwd()).kind);`], {
		cwd, env: { ...process.env, PATH: path.join(root, "missing-executables") }, encoding: "utf8", windowsHide: true
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "folder");
	assert.equal(spawnSync("git", ["init", "-q"], { cwd, windowsHide: true }).status, 0);
	assert.equal(isGitWorkspace(cwd), true);
	assert.doesNotThrow(() => workspaceDiff(cwd));
});

test("a plain folder rejects Git-only VPS synchronization before starting any provider", (t) => {
	const { manager, calls } = fixture(t, null, { git: false });
	manager.runner.validateRemote = () => {};
	assert.throws(() => manager.create({ task: "Implement", mode: "split", policy: "medium" }), /synchronization currently requires a Git repository/);
	assert.equal(calls.length, 0);
	assert.equal(manager.list().length, 0);
	assert.equal(spawnSync("git", ["init", "-q"], { cwd: manager.cwd, windowsHide: true }).status, 0);
	assert.throws(() => manager.create({ task: "Implement", mode: "split", policy: "medium" }), /requires a Git repository with an existing commit/);
	assert.equal(calls.length, 0);
});

test("the HTTP API creates a plain-folder task and serves its non-Git changes", async (t) => {
	const { cwd, manager } = fixture(t, null, { git: false });
	const app = await startWeb({ cwd, manager, port: 0 });
	t.after(() => app.close());
	const login = await fetch(`${app.url}/api/session`, {
		method: "POST", headers: { "Content-Type": "application/json", Origin: app.url },
		body: JSON.stringify({ token: new URL(app.loginUrl).hash.slice(1) })
	});
	assert.equal(login.status, 200);
	const { csrf } = await login.json();
	const headers = { Cookie: login.headers.get("set-cookie").split(";")[0], "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: app.url };
	const config = await (await fetch(`${app.url}/api/bootstrap`, { headers })).json();
	assert.equal(config.workspaceKind, "folder");
	assert.equal(config.cwd, cwd);
	const response = await fetch(`${app.url}/api/runs`, { method: "POST", headers, body: JSON.stringify({ task: "Implement", mode: "skip-everything", requestId: randomUUID() }) });
	assert.equal(response.status, 201);
	const run = await settle(manager, (await response.json()).id);
	assert.equal(run.phase, "completed", run.error);
	const artifacts = await fetch(`${app.url}/api/runs/${run.id}/artifacts`, { headers });
	assert.equal(artifacts.status, 200);
	assert.match((await artifacts.json()).status, /^A result\.txt$/m);
});

test("the absolute Duo CLI starts from another project without using a nearby package.json", (t) => {
	const { cwd, root } = fixture(t, null, { git: false });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { web: "not-duo" } }));
	const entry = new URL("../plugins/codex/scripts/lib/collaboration-cli.mjs", import.meta.url).href;
	const code = `const {handleWeb}=await import(${JSON.stringify(entry)}); await handleWeb(process.argv.slice(1)); process.emit('SIGTERM');`;
	for (const args of [["--port", "0"], [cwd, "--port", "0"], ["--cwd", cwd, "--port", "0"]]) {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", ...args], {
			cwd, env: { ...process.env, DUO_HOME: path.join(root, "cli-state") }, encoding: "utf8", windowsHide: true, timeout: 10000
		});
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes(`Project: ${cwd}`));
	}
	const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
	assert.equal(manifest.bin.duo, "duo.mjs");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture } from "./collaboration-fixture.mjs";
import { workspaceDiff, projectFile } from "../plugins/codex/scripts/lib/collaboration-workspace.mjs";
import { WebSocketCodexAppServerClient, assertWebSocketSupport } from "../plugins/codex/scripts/lib/app-server.mjs";
import { CodexHost } from "../plugins/codex/scripts/lib/agent-windows.mjs";
import { startWeb } from "../plugins/codex/scripts/lib/web-server.mjs";

const MARKER = "SYNTHETIC-SECRET-MARKER";
const PROTECTED = /SYNTHETIC-SECRET-MARKER|\.env|secrets\.(json|txt)|id_rsa/;

function tempDir(t, prefix) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function write(cwd, name, content) {
	fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
	fs.writeFileSync(path.join(cwd, name), content);
}

function repository(t, files, { commit = true } = {}) {
	const cwd = tempDir(t, "duo-diff-");
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Test");
	git(cwd, "config", "user.email", "test@example.invalid");
	git(cwd, "config", "core.autocrlf", "false");
	for (const [name, content] of Object.entries(files)) write(cwd, name, content);
	if (commit) {
		git(cwd, "add", ".");
		git(cwd, "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");
	}
	return cwd;
}

const secret = (label) => `${MARKER} ${label}\nline two of the synthetic fixture\nline three of the synthetic fixture\n`;

test("Git artifacts omit protected paths across staged and unstaged changes", (t) => {
	const cwd = repository(t, { ".env": secret("one"), "secrets.json": secret("two"), "config/id_rsa": secret("three"), "src/a.txt": "ordinary one\n" });
	fs.appendFileSync(path.join(cwd, ".env"), `${MARKER} staged\n`);
	git(cwd, "add", ".env");
	fs.appendFileSync(path.join(cwd, "secrets.json"), `${MARKER} unstaged\n`);
	fs.appendFileSync(path.join(cwd, "config/id_rsa"), `${MARKER} staged\n`);
	git(cwd, "add", "config/id_rsa");
	fs.appendFileSync(path.join(cwd, "src/a.txt"), "ordinary two\n");
	const { status, diff } = workspaceDiff(cwd);
	assert.match(diff, /\+ordinary two/);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(status, PROTECTED);
	assert.match(status, /^ M src\/a\.txt$/m);
	assert.match(status, /^3 protected entries hidden$/m);
});

test("Git artifacts omit protected paths in a repository without an initial commit", (t) => {
	const cwd = repository(t, { ".env": secret("one"), "secrets.json": secret("two"), "src/a.txt": "ordinary one\n" }, { commit: false });
	git(cwd, "add", ".");
	fs.appendFileSync(path.join(cwd, ".env"), `${MARKER} unstaged\n`);
	fs.appendFileSync(path.join(cwd, "src/a.txt"), "ordinary two\n");
	const { status, diff } = workspaceDiff(cwd);
	assert.match(diff, /\+ordinary one/);
	assert.match(diff, /\+ordinary two/);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(status, PROTECTED);
	assert.match(status, /^AM src\/a\.txt$/m);
	assert.match(status, /^2 protected entries hidden$/m);
});

test("Git artifacts work for a workspace in a repository subdirectory", (t) => {
	const root = repository(t, { "sub/a.txt": "ordinary one\n", "sub/.env": secret("sub"), "other/b.txt": "outside one\n" });
	fs.appendFileSync(path.join(root, "sub/a.txt"), "ordinary two\n");
	fs.appendFileSync(path.join(root, "sub/.env"), `${MARKER} changed\n`);
	fs.appendFileSync(path.join(root, "other/b.txt"), "outside two\n");
	const { status, diff } = workspaceDiff(path.join(root, "sub"));
	assert.match(diff, /\+ordinary two/);
	assert.doesNotMatch(diff, /outside two/);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(status, PROTECTED);
});

test("renaming a protected file to an ordinary name does not expose it", (t) => {
	const cwd = repository(t, { ".env": secret("rename"), "src/a.txt": "ordinary\n" });
	git(cwd, "mv", ".env", "notes.txt");
	fs.appendFileSync(path.join(cwd, "notes.txt"), "unstaged edit\n");
	const { status, diff } = workspaceDiff(cwd);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(diff, /notes\.txt/);
	assert.doesNotMatch(status, /notes\.txt|\.env/);
	assert.match(status, /^1 protected entry hidden$/m);
});

test("renaming an ordinary file to a protected name does not expose it", (t) => {
	const cwd = repository(t, { "src/b.txt": "ordinary b content\nsecond line\nthird line\n" });
	git(cwd, "mv", "src/b.txt", "secrets.json");
	const { status, diff } = workspaceDiff(cwd);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(status, PROTECTED);
	assert.match(status, /^1 protected entry hidden$/m);
});

test("a detected copy of a protected file is not shown", (t) => {
	const cwd = repository(t, { ".env": secret("copy"), "src/a.txt": "ordinary\n" });
	fs.appendFileSync(path.join(cwd, ".env"), "changed\n");
	fs.copyFileSync(path.join(cwd, ".env"), path.join(cwd, "copy.txt"));
	git(cwd, "add", ".env", "copy.txt");
	if (!/^C/m.test(git(cwd, "diff", "HEAD", "--name-status", "-M", "-C"))) {
		t.skip("Git did not classify the file as a copy; undetected copies are a documented limit.");
		return;
	}
	assert.doesNotMatch(workspaceDiff(cwd).diff, PROTECTED);
});

test("filenames containing pathspec wildcards are matched literally", { skip: process.platform === "win32" && "Windows filenames cannot contain *." }, (t) => {
	const cwd = repository(t, { "*.txt": "literal one\n", "secrets.txt": secret("glob") });
	fs.appendFileSync(path.join(cwd, "*.txt"), "literal two\n");
	fs.appendFileSync(path.join(cwd, "secrets.txt"), `${MARKER} changed\n`);
	const { status, diff } = workspaceDiff(cwd);
	assert.match(diff, /\+literal two/);
	assert.doesNotMatch(diff, PROTECTED);
	assert.doesNotMatch(status, PROTECTED);
});

test("file preview allows names starting with two dots but still rejects escapes and Git metadata", (t) => {
	const cwd = tempDir(t, "duo-preview-");
	write(cwd, "..notes.md", "Synthetic notes\n");
	write(cwd, ".GIT/config", "synthetic\n");
	assert.equal(projectFile(cwd, "..notes.md"), "Synthetic notes\n");
	assert.throws(() => projectFile(cwd, "../outside"), /outside the configured project/);
	assert.throws(() => projectFile(cwd, ".GIT/config"), /outside the configured project|Protected files/);
});

test("the WebSocket App Server client authenticates its handshake with the bearer token", async (t) => {
	let headers;
	const server = http.createServer();
	server.on("upgrade", (request, socket) => { headers = request.headers; socket.destroy(); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `ws://127.0.0.1:${server.address().port}`;
	await assert.rejects(WebSocketCodexAppServerClient.connect(process.cwd(), { url, token: "synthetic-token" }), /Could not connect/);
	assert.equal(headers.authorization, "Bearer synthetic-token");
});

test("agent windows fail clearly when the runtime has no WebSocket client", async (t) => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
	t.after(() => {
		if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
		else delete globalThis.WebSocket;
	});
	assert.throws(() => assertWebSocketSupport(), /Node\.js 22\.4 or later/);
	await assert.rejects(new CodexHost(process.cwd()).connect(), /Node\.js 22\.4 or later/);
});

async function signedIn(t, options = {}) {
	const context = fixture(t);
	const app = await startWeb({ cwd: context.cwd, manager: context.manager, port: 0, ...options });
	t.after(() => app.close());
	const login = await fetch(`${app.url}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.url }, body: JSON.stringify({ token: new URL(app.loginUrl).hash.slice(1) }) });
	assert.equal(login.status, 200);
	const { csrf } = await login.json();
	return { app, csrf, cookie: login.headers.get("set-cookie").split(";")[0] };
}

test("web returns 404 for an unknown run", async (t) => {
	const { app, cookie } = await signedIn(t);
	assert.equal((await fetch(`${app.url}/api/runs/${randomUUID()}`, { headers: { Cookie: cookie } })).status, 404);
});

test("web sessions expire on the server", async (t) => {
	const { app, cookie } = await signedIn(t, { sessionSeconds: 1 });
	assert.equal((await fetch(`${app.url}/api/runs`, { headers: { Cookie: cookie } })).status, 200);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal((await fetch(`${app.url}/api/runs`, { headers: { Cookie: cookie } })).status, 401);
});

test("web rejects request bodies over 1 MB", async (t) => {
	const { app, csrf, cookie } = await signedIn(t);
	const body = JSON.stringify({ requestId: randomUUID(), task: "x".repeat(1024 * 1024) });
	const status = await new Promise((resolve, reject) => {
		const request = http.request(`${app.url}/api/runs`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: app.url, "Content-Length": Buffer.byteLength(body) } }, (response) => { response.resume(); resolve(response.statusCode); });
		request.on("error", reject);
		request.end(body);
	});
	assert.equal(status, 413);
});

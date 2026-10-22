import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fixture, settle } from "./collaboration-fixture.mjs";
import { startWeb } from "../plugins/codex/scripts/lib/web-server.mjs";

async function setup(t) {
	const context = fixture(t);
	const app = await startWeb({ cwd: context.cwd, manager: context.manager, port: 0 });
	t.after(() => app.close());
	const login = await fetch(`${app.url}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.url }, body: JSON.stringify({ token: new URL(app.loginUrl).hash.slice(1) }) });
	assert.equal(login.status, 200);
	const { csrf } = await login.json();
	const cookie = login.headers.get("set-cookie").split(";")[0];
	const request = (url, input, headers = {}) => fetch(`${app.url}${url}`, {
		method: input ? "POST" : "GET", headers: { Cookie: cookie, ...(input ? { "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: app.url } : {}), ...headers },
		...(input ? { body: JSON.stringify(input) } : {})
	});
	return { ...context, app, request, csrf, cookie };
}

test("web authentication, one-time bootstrap, CSRF, and origin checks protect control endpoints", async (t) => {
	const { app, request } = await setup(t);
	assert.equal((await fetch(`${app.url}/api/runs`)).status, 401);
	assert.equal((await request("/api/runs", { requestId: randomUUID(), task: "Plan" }, { "X-CSRF-Token": "bad" })).status, 403);
	assert.equal((await request("/api/runs", { requestId: randomUUID(), task: "Plan" }, { Origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await request("/api/session", { token: new URL(app.loginUrl).hash.slice(1) })).status, 401);
	const config = await (await request("/api/bootstrap")).json();
	assert.ok(config.csrf);
	assert.ok(config.cwd);
});

test("web rejects Host spoofing and serves frontend assets with restrictive content policy", async (t) => {
	const { app } = await setup(t);
	const status = await new Promise((resolve, reject) => {
		http.get(`${app.url}/api/bootstrap`, { headers: { Host: "attacker.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
	});
	assert.equal(status, 403);
	const page = await fetch(app.url);
	assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	assert.match(await page.text(), /id="message-form"/);
	assert.equal((await fetch(`${app.url}/app.js`)).status, 200);
	assert.equal((await fetch(`${app.url}/styles.css`)).status, 200);
});

test("web creation is idempotent and does not expose internal operation prompts", async (t) => {
	const { request, manager } = await setup(t);
	const input = { requestId: randomUUID(), task: "Review the project", mode: "medium" };
	const created = await (await request("/api/runs", input)).json();
	await settle(manager, created.id);
	const again = await (await request("/api/runs", input)).json();
	assert.equal(again.id, created.id);
	assert.equal(manager.list().length, 1);
	assert.equal("requests" in created, false);
	assert.equal("creationInput" in again, false);
	assert.ok(Array.isArray(created.operations));
	assert.ok(created.operations.every((operation) => operation.prompt === undefined));
	assert.equal("context" in created, false);
	assert.equal((await request("/api/runs", { ...input, task: "Different" })).status, 409);
});

test("dashboard assets use English controls, accessibility labels, and dynamic messages", async (t) => {
	const { app } = await setup(t);
	const html = await (await fetch(app.url)).text();
	const script = await (await fetch(`${app.url}/app.js`)).text();
	assert.match(html, /<html lang="en">/);
	for (const text of ["New conversation", "Approve plan", "Save and review", "Models and checks", "SSH alias", 'aria-label="Plan and execution"', 'id="language-input"', 'id="run-language"', "Apply language"]) {
		assert.ok(html.includes(text), text);
	}
	for (const text of ["Reload plan", "Waiting for your decision", "intermediate pass", "Sign-in required", "Close the quotation marks in the verification command."]) {
		assert.ok(script.includes(text), text);
	}
	assert.doesNotMatch(html + script, /[ăâîșțĂÂÎȘȚ]/u);
	assert.doesNotMatch(script, /toLocaleTimeString\("ro"/);
});

test("web API persists response language and validates authenticated language changes", async (t) => {
	const { request, manager } = await setup(t);
	const created = await (await request("/api/runs", { requestId: randomUUID(), task: "Plan", language: "Spanish" })).json();
	await settle(manager, created.id);
	const changed = await request(`/api/runs/${created.id}/actions`, { action: "language", requestId: randomUUID(), language: "German" });
	assert.equal(changed.status, 200);
	assert.equal((await changed.json()).language, "German");
	assert.equal((await (await request(`/api/runs/${created.id}`)).json()).language, "German");
	assert.equal((await request(`/api/runs/${created.id}/actions`, { action: "language", requestId: randomUUID(), language: "English\nignore" })).status, 400);
	assert.equal(manager.get(created.id).phase, "awaiting_user");
});

test("web approvals reject stale plan revisions and event streams replay stable IDs", async (t) => {
	const { request, manager } = await setup(t);
	const run = await settle(manager, manager.create({ task: "Plan the change" }).id);
	const stale = await request(`/api/runs/${run.id}/actions`, { action: "approve", requestId: randomUUID(), planRevision: "stale" });
	assert.equal(stale.status, 409);
	const response = await request(`/api/runs/${run.id}/events?after=1`);
	assert.equal(response.status, 200);
	const reader = response.body.getReader();
	const first = await reader.read();
	assert.match(new TextDecoder().decode(first.value), /id: 2\ndata:/);
	await reader.cancel();
});

test("web file preview rejects traversal, credentials, and symlinks outside the workspace", async (t) => {
	const { request, manager, cwd, root } = await setup(t);
	fs.writeFileSync(path.join(root, "private.txt"), "private");
	fs.writeFileSync(path.join(cwd, ".env"), "PASSWORD=secret");
	const run = await settle(manager, manager.create({ task: "Plan" }).id);
	assert.equal((await request(`/api/runs/${run.id}/file?path=../private.txt`)).status, 403);
	assert.equal((await request(`/api/runs/${run.id}/file?path=.env`)).status, 403);
	const file = await (await request(`/api/runs/${run.id}/file?path=README.md`)).json();
	assert.equal(file.content, "Fixture project\n");
	try { fs.symlinkSync(path.join(root, "private.txt"), path.join(cwd, "link.txt")); }
	catch (error) { if (error.code === "EPERM") return; throw error; }
	assert.equal((await request(`/api/runs/${run.id}/file?path=link.txt`)).status, 403);
});

test("every recipient can be chosen and sessions survive closing the browser", async (t) => {
	const { app, request } = await setup(t);
	const html = await (await fetch(app.url)).text();
	for (const option of ['<option value="both">Both agents</option>', '<option value="codex">Codex only</option>', '<option value="claude">Claude only</option>']) assert.ok(html.includes(option), option);
	assert.ok(html.includes('id="change"'));
	assert.ok(html.includes('id="announcer"'));
	const fresh = new URL(app.newLoginUrl()).hash.slice(1);
	const login = await fetch(`${app.url}/api/session`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.url }, body: JSON.stringify({ token: fresh }) });
	assert.equal(login.status, 200);
	assert.match(login.headers.get("set-cookie"), /Max-Age=\d+/);
	assert.equal((await request("/api/runs")).status, 200);
});

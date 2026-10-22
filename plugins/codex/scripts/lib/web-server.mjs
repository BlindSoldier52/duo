import fs from "node:fs";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Collaboration } from "./collaboration.mjs";
import { execute } from "./collaboration-process.mjs";
import { fault, redact, parseCliJson, digest } from "./collaboration-protocol.mjs";
import { projectFile } from "./collaboration-workspace.mjs";

const ASSETS = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

async function body(request) {
	if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw fault("JSON request body required.", 415);
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 1024 * 1024) throw fault("Request body is too large.", 413);
		chunks.push(chunk);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fault("Invalid JSON body."); }
}

function equal(a, b) {
	return typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function json(response, value, status = 200) {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

export async function runtimeStatus(cwd) {
	const result = {};
	for (const agent of ["codex", "claude"]) {
		try {
			const version = await execute(agent, ["--version"], { cwd, timeoutMs: 10000 });
			let auth = "unknown";
			try {
				const probe = await execute(agent, agent === "codex" ? ["login", "status"] : ["auth", "status"], { cwd, timeoutMs: 10000 });
				if (agent === "claude") {
					const status = parseCliJson(probe.stdout);
					auth = status.loggedIn ? (status.authMethod ?? status.loginMethod ?? "signed-in") : "signed-out";
				} else auth = /chatgpt/i.test(probe.stdout + probe.stderr) ? "ChatGPT" : probe.status === 0 ? "API/provider" : "signed-out";
			} catch { auth = "unknown"; }
			result[agent] = { available: version.status === 0, version: redact(version.stdout.trim()).slice(0, 100), auth };
		} catch (error) { result[agent] = { available: false, version: null, auth: "unknown", error: redact(error.message) }; }
	}
	return result;
}

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const RUNTIME_TTL_MS = 60 * 1000;

export async function startWeb(options) {
	const manager = options.manager ?? new Collaboration(options.cwd, options);
	let bootstrap = options.token ?? randomBytes(32).toString("hex");
	let runtime = null;
	const live = (id) => manager.running.get(id)?.run ?? manager.get(id);
	const checkRuntime = async () => {
		if (runtime && Date.now() - runtime.at < RUNTIME_TTL_MS) return runtime.value;
		const value = await (options.runtimeStatus ?? runtimeStatus)(manager.cwd);
		runtime = { at: Date.now(), value };
		return value;
	};
	const sessionMs = (options.sessionSeconds ?? SESSION_SECONDS) * 1000;
	const sessions = new Map();
	const streams = new Set();
	let origin;
	let closing = false;
	const server = http.createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
		try {
			if (request.headers.host !== new URL(origin).host) throw fault("Invalid Host header.", 403);
			if (request.headers.origin && request.headers.origin !== origin) throw fault("Cross-origin requests are not allowed.", 403);
			if (request.headers["sec-fetch-site"] === "cross-site") throw fault("Cross-site requests are not allowed.", 403);
			const url = new URL(request.url, origin);
			const asset = ASSETS.get(url.pathname);
			if (request.method === "GET" && asset) {
				response.writeHead(200, { "Content-Type": asset[1] });
				response.end(fs.readFileSync(new URL(`../../web/${asset[0]}`, import.meta.url)));
				return;
			}
			if (url.pathname === "/api/session" && request.method === "POST") {
				const input = await body(request);
				if (!bootstrap || !equal(input.token, bootstrap)) throw fault("Invalid or already used sign-in link. Use the link printed by the server.", 401);
				bootstrap = null;
				const now = Date.now();
				for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
				const token = randomBytes(32).toString("hex");
				const csrf = randomBytes(32).toString("hex");
				sessions.set(token, { csrf, expires: now + sessionMs });
				response.setHeader("Set-Cookie", `companion=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(sessionMs / 1000)}`);
				json(response, { csrf });
				return;
			}
			const cookie = /(?:^|;\s*)companion=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
			if (sessions.get(cookie)?.expires <= Date.now()) sessions.delete(cookie);
			const csrf = sessions.get(cookie)?.csrf;
			if (!csrf) throw fault("Open the sign-in link printed in the terminal to connect this browser.", 401);
			if (request.method !== "GET" && !equal(request.headers["x-csrf-token"], csrf)) throw fault("Invalid CSRF token.", 403);
			if (request.method === "GET" && url.pathname === "/api/bootstrap") {
				json(response, { csrf, cwd: manager.cwd, workspaceKind: manager.workspaceKind, runs: manager.list().map(summary) });
			} else if (request.method === "GET" && url.pathname === "/api/runtime") {
				json(response, await checkRuntime());
			} else if (url.pathname === "/api/runs" && request.method === "GET") {
				json(response, manager.list().map(summary));
			} else if (url.pathname === "/api/runs" && request.method === "POST") {
				const input = await body(request);
				if (!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId ?? "")) throw fault("A creation requestId is required.");
				const existing = manager.list().find((run) => run.creationRequestId === input.requestId);
				if (existing) {
					if (existing.creationInput !== digest(JSON.stringify(input))) throw fault("Creation request ID was reused with different input.", 409);
					json(response, publicRun(existing));
				} else {
					const run = manager.create(input);
					const live = manager.running.get(run.id)?.run ?? run;
					live.creationRequestId = input.requestId;
					live.creationInput = digest(JSON.stringify(input));
					manager.store.save(live);
					json(response, publicRun(live), 201);
				}
			} else {
				const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(actions|events|artifacts|file))?$/.exec(url.pathname);
				if (!match) throw fault("Endpoint not found.", 404);
				const [, id, operation] = match;
				const run = live(id);
				if (request.method === "GET" && !operation) json(response, publicRun(run));
				else if (request.method === "POST" && operation === "actions") {
					const input = await body(request);
					json(response, publicRun(manager.action(id, input.action, input)));
				} else if (request.method === "GET" && operation === "artifacts") {
					const artifacts = manager.artifacts(id);
					json(response, { status: redact(artifacts.status), diff: redact(artifacts.diff) });
				} else if (request.method === "GET" && operation === "file") {
					json(response, { content: redact(projectFile(manager.cwd, url.searchParams.get("path"))) });
				} else if (request.method === "GET" && operation === "events") {
					const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
					if (!Number.isSafeInteger(after) || after < 0) throw fault("Invalid event cursor.");
					response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
					response.flushHeaders();
					const send = (event) => {
						if (event.runId !== id || response.destroyed) return;
						if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
						response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
					};
					for (const event of run.events) if (event.id > after) send({ runId: id, ...event });
					manager.on("event", send);
					streams.add(response);
					const timer = setInterval(() => response.write(": heartbeat\n\n"), 15000);
					response.on("close", () => { clearInterval(timer); manager.off("event", send); streams.delete(response); });
				} else throw fault("Method not allowed.", 405);
			}
		} catch (error) {
			if (!response.headersSent) json(response, { error: redact(error.message) }, error.status ?? (error.code === "ENOENT" ? 404 : 500));
			else response.destroy();
		}
	});
	server.requestTimeout = 15000;
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 3210, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${server.address().port}`;
	return {
		manager, server, url: origin, loginUrl: `${origin}/#${bootstrap}`,
		newLoginUrl() {
			bootstrap = randomBytes(32).toString("hex");
			return `${origin}/#${bootstrap}`;
		},
		async close() {
			if (closing) return;
			closing = true;
			for (const response of streams) response.end();
			const stopped = new Promise((resolve) => server.close(resolve));
			server.closeIdleConnections?.();
			await manager.close();
			await stopped;
		}
	};
}

function summary(run) {
	return { id: run.id, task: run.task, phase: run.phase, paused: run.paused, mode: run.mode, updatedAt: run.updatedAt };
}

function publicRun(run) {
	const { operations = {}, requests, creationInput, context, ...rest } = run;
	return {
		...rest,
		operations: Object.values(operations).map(({ id, agent, phase, startedAt, write, model }) => ({ id, agent, phase, startedAt, write, model }))
	};
}

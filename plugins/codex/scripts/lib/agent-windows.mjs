import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketCodexAppServerClient, assertWebSocketSupport } from "./app-server.mjs";
import { resolveExecutable, terminateProcessTree } from "./process.mjs";
import { RESPONSE_SCHEMA } from "./collaboration-protocol.mjs";
import { createDuoTempDir } from "./duo-paths.mjs";
import { claudeTools, cleanEnvironment } from "./claude.mjs";

const HOOK = fileURLToPath(new URL("./claude-turn-hook.mjs", import.meta.url));
const CONNECT_TIMEOUT_MS = 20000;
const POLL_MS = 500;

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function running(child) {
	return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

function stop(child) {
	if (!running(child)) return;
	try { terminateProcessTree(child.pid); } catch {}
}

function openWindow(command, args, options) {
	const [file, values] = resolveExecutable(command, args, options.env);
	const child = spawn(file, values, { cwd: options.cwd, env: options.env, detached: true, stdio: "ignore", windowsHide: false });
	child.on("error", () => {});
	child.unref();
	return child;
}

function forward(file) {
	return file.replace(/\\/g, "/");
}

export class CodexHost {
	constructor(cwd) {
		this.cwd = cwd;
		this.server = null;
		this.window = null;
		this.thread = null;
	}

	async start() {
		if (running(this.server)) return;
		this.port = await freePort();
		this.token = randomBytes(32).toString("hex");
		this.url = `ws://127.0.0.1:${this.port}`;
		const digest = createHash("sha256").update(this.token).digest("hex");
		const [file, values] = resolveExecutable("codex", ["app-server", "--listen", this.url, "--ws-auth", "capability-token", "--ws-token-sha256", digest]);
		this.server = spawn(file, values, { cwd: this.cwd, stdio: "ignore", windowsHide: true });
		this.server.on("error", () => {});
	}

	async connect() {
		assertWebSocketSupport();
		await this.start();
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		while (true) {
			try { return await WebSocketCodexAppServerClient.connect(this.cwd, { url: this.url, token: this.token }); }
			catch (error) {
				if (Date.now() > deadline || !running(this.server)) throw error;
				await sleep(250);
			}
		}
	}

	show(threadId) {
		if (running(this.window) && this.thread === threadId) return;
		stop(this.window);
		this.thread = threadId;
		this.window = openWindow("codex", ["resume", threadId, "--remote", this.url, "--remote-auth-token-env", "DUO_CODEX_TOKEN"], {
			cwd: this.cwd, env: { ...process.env, DUO_CODEX_TOKEN: this.token }
		});
	}

	close() {
		stop(this.window);
		stop(this.server);
		this.window = null;
		this.server = null;
	}
}

function hook(mode, file) {
	return `"${forward(process.execPath)}" "${forward(HOOK)}" ${mode} "${forward(file)}"`;
}

function instructions(prompt) {
	return `${prompt}\n\nWhen you are done, end your turn with a final message that contains only one JSON object, with no other text and no code fence. It must match this JSON schema:\n${JSON.stringify(RESPONSE_SCHEMA)}\n`;
}

export class ClaudeWindow {
	constructor() {
		this.window = null;
		this.directory = null;
	}

	files() {
		this.directory ??= createDuoTempDir("claude-");
		const id = randomUUID();
		const file = (suffix) => path.join(this.directory, `${id}.${suffix}`);
		return { prompt: file("prompt.md"), result: file("result.json"), activity: file("activity.jsonl"), settings: file("settings.json") };
	}

	arguments(options, files, session) {
		const tools = claudeTools(options.write);
		const args = [
			...(options.session ? ["--resume", session] : ["--session-id", session]),
			"--restricted", "--settings", files.settings, "--setting-sources", "",
			"--permission-mode", options.write ? "acceptEdits" : "dontAsk",
			"--tools", tools, "--allowedTools", tools, "--add-dir", this.directory,
			"--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome"
		];
		if (options.systemPromptFile) args.push("--append-system-prompt-file", options.systemPromptFile);
		if (options.model) args.push("--model", options.model);
		if (options.effort) args.push("--effort", options.effort);
		args.push(`Read the Duo turn instructions in ${forward(files.prompt)} and follow them.`);
		return args;
	}

	async turn(cwd, options) {
		const env = cleanEnvironment();
		const files = this.files();
		const session = options.session ?? randomUUID();
		fs.writeFileSync(files.prompt, instructions(options.prompt));
		fs.writeFileSync(files.settings, JSON.stringify({ hooks: {
			Stop: [{ hooks: [{ type: "command", command: hook("stop", files.result) }] }],
			PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook("activity", files.activity) }] }]
		} }));
		stop(this.window);
		this.window = openWindow("claude", this.arguments(options, files, session), { cwd, env });
		options.onSession?.({ session, model: null });
		try { return await this.wait(files, session, options); }
		catch (error) { stop(this.window); throw error; }
	}

	async wait(files, session, options) {
		const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
		let reported = 0;
		while (true) {
			options.signal?.throwIfAborted();
			reported = this.report(files.activity, reported, options.onProgress);
			if (fs.existsSync(files.result)) {
				const result = JSON.parse(fs.readFileSync(files.result, "utf8"));
				if (result.error) throw new Error(result.error);
				return { response: result.response, session: result.session ?? session, model: options.model ?? null };
			}
			if (!running(this.window)) throw new Error("The Claude window closed before Claude finished its answer.");
			if (Date.now() > deadline) throw new Error("Operation timed out; inspect the checkpoint before retrying.");
			await sleep(POLL_MS);
		}
	}

	report(file, offset, onProgress) {
		if (!onProgress || !fs.existsSync(file)) return offset;
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		for (const line of lines.slice(offset)) {
			try { onProgress(JSON.parse(line)); } catch {}
		}
		return lines.length;
	}

	close() {
		stop(this.window);
		this.window = null;
	}
}

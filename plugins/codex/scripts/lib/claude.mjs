import path from "node:path";
import { execute } from "./collaboration-process.mjs";
import { RESPONSE_SCHEMA, validateResponse, parseCliJson } from "./collaboration-protocol.mjs";

const AUTH_TTL_MS = 10 * 60 * 1000;
const authenticated = new Map();

export async function ensureClaudeLogin(cwd, signal) {
	await ensureLogin(execute, cwd, cleanEnvironment(), signal);
}

const INHERITED_SESSION = /^(?:CLAUDECODE|CLAUDE_ENV_FILE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH)|CODEX_COMPANION_SESSION_ID)$/;

export function cleanEnvironment(source = process.env) {
	const env = { ...source, CODEX_COMPANION_ORCHESTRATED: "1" };
	if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) {
		throw new Error("Claude API/provider credentials are set. Launch with subscription authentication to avoid unintended API billing.");
	}
	for (const name of Object.keys(env)) if (INHERITED_SESSION.test(name)) delete env[name];
	return env;
}

async function ensureLogin(run, cwd, env, signal) {
	if (run !== execute || Date.now() - (authenticated.get(cwd) ?? 0) >= AUTH_TTL_MS) {
		const result = await run("claude", ["auth", "status"], { cwd, env, signal, timeoutMs: 15000 });
		const auth = parseCliJson(result.stdout);
		if (result.status !== 0 || !auth.loggedIn || !(auth.authMethod === "claude.ai" || (auth.authMethod === "oauth_token" && env.CLAUDE_CODE_OAUTH_TOKEN))) {
			throw new Error("Claude is not authenticated with a Claude subscription. Sign in through Claude Code before starting a collaboration.");
		}
		if (run === execute) authenticated.set(cwd, Date.now());
	}
}

export function claudeTools(write) {
	if (!write) return "Read,Glob,Grep";
	return process.platform === "win32" ? "Read,Glob,Grep,Edit,Write,Bash,PowerShell" : "Read,Glob,Grep,Edit,Write,Bash";
}

export function describeCommand(command) {
	const text = command.replace(/\s+/g, " ").trim();
	return `Running command: ${text.length > 96 ? `${text.slice(0, 93)}...` : text}`;
}

function claudeArguments(options) {
	const tools = claudeTools(options.write);
	const args = [
		"-p", "--output-format", "stream-json", "--verbose",
		"--json-schema", JSON.stringify(RESPONSE_SCHEMA), "--restricted",
		"--permission-mode", options.write ? "acceptEdits" : "dontAsk",
		"--tools", tools, "--allowedTools", tools, "--disable-slash-commands",
		"--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
		"--settings", '{"disableAllHooks":true}', "--no-chrome"
	];
	if (options.systemPromptFile) args.push("--append-system-prompt-file", options.systemPromptFile);
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);
	if (options.session) args.push("--resume", options.session);
	return args;
}

function describeTool(block, cwd) {
	const input = block.input ?? {};
	if (typeof input.command === "string") return describeCommand(input.command);
	const target = input.file_path ?? input.path ?? input.pattern ?? "";
	const shown = typeof target === "string" && path.isAbsolute(target) ? path.relative(cwd, target) || "." : target;
	if (block.name === "StructuredOutput") return "Writing the answer.";
	return shown ? `${block.name} ${shown}` : block.name;
}

class StreamReader {
	constructor(cwd, onProgress) {
		this.cwd = cwd;
		this.onProgress = onProgress;
		this.buffer = "";
		this.result = null;
	}

	push(chunk) {
		this.buffer += chunk;
		let newline;
		while ((newline = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.read(line);
		}
	}

	finish(stdout) {
		this.read(this.buffer);
		this.buffer = "";
		if (this.result) return this.result;
		try { return parseCliJson(stdout); }
		catch { return null; }
	}

	read(line) {
		if (!line.trim()) return;
		let event;
		try { event = parseCliJson(line); } catch { return; }
		if (event.type === "result") this.result = event;
		if (event.type !== "assistant" || !this.onProgress) return;
		for (const block of event.message?.content ?? []) {
			if (block.type === "tool_use") this.onProgress({ message: describeTool(block, this.cwd) });
		}
	}
}

export async function runClaude(cwd, options) {
	const env = cleanEnvironment();
	const run = options.execute ?? execute;
	await ensureLogin(run, cwd, env, options.signal);
	const reader = new StreamReader(cwd, options.onProgress);
	const result = await run("claude", claudeArguments(options), {
		cwd, env, input: options.prompt, signal: options.signal, timeoutMs: options.timeoutMs,
		maxOutput: 64 * 1024 * 1024, onOutput: (chunk) => reader.push(chunk)
	});
	const envelope = reader.finish(result.stdout);
	if (!envelope) throw new Error(`Claude returned invalid JSON (exit ${result.status}): ${result.stderr.slice(-2000)}`);
	if (result.status !== 0 || envelope.is_error) {
		throw new Error(`Claude failed: ${envelope.result ?? envelope.errors?.join("; ") ?? result.stderr}`);
	}
	if (!envelope.session_id) throw new Error("Claude did not return a persistent session ID.");
	const model = Object.keys(envelope.modelUsage ?? {})[0] ?? null;
	options.onSession?.({ session: envelope.session_id, model });
	return { response: validateResponse(envelope.structured_output), session: envelope.session_id, model };
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AgentRunner } from "./lib/collaboration-agents.mjs";
import { resolveStateDir } from "./lib/state.mjs";
import { writeJsonFile } from "./lib/fs.mjs";
import { acquirePidLockSync } from "./lib/lockfile.mjs";
import { workspaceRevision } from "./lib/collaboration-workspace.mjs";
import { git, snapshot, bundle, receiveBundle, assertSnapshotWorkspace } from "./lib/collaboration-git.mjs";
import { digest, redact } from "./lib/collaboration-protocol.mjs";
import { runCheck } from "./lib/collaboration-process.mjs";
import { isPidAlive } from "./lib/process.mjs";

function identifier(value) {
	if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid remote job ID.");
	return value;
}

function storage(cwd) {
	const directory = path.join(resolveStateDir(cwd), "remote-jobs");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
}

function ownedWorkspace(cwd, runId) {
	return path.join(storage(cwd), "worktrees", identifier(runId));
}

export async function remoteRequest(cwd, input) {
	assertSnapshotWorkspace(cwd);
	const directory = storage(cwd);
	if (input.action === "prepare") {
		identifier(input.runId);
		const revision = receiveBundle(cwd, input.bundle, `refs/duo/${input.runId}/input`);
		const target = ownedWorkspace(cwd, input.runId);
		const release = acquirePidLockSync(path.join(directory, `${input.runId}.sync.lock`), { timeoutMs: 5000 });
		try {
			if (!fs.existsSync(target)) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				git(cwd, ["worktree", "add", "--detach", target, revision]);
			} else {
				if (git(target, ["status", "--porcelain"])) throw new Error("Remote task worktree has unexported changes. Inspect it before synchronizing.");
				git(target, ["checkout", "--detach", revision]);
			}
			return { cwd: target, revision };
		} finally { release(); }
	}
	const id = identifier(input.id);
	const stateFile = path.join(directory, `${id}.json`);
	if (input.action === "status") {
		if (!fs.existsSync(stateFile)) return { status: "missing" };
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		if ((state.status === "running" && !isPidAlive(state.pid)) || (state.status === "starting" && Date.now() - fs.statSync(stateFile).mtimeMs > 30000)) {
			const failed = { ...state, status: "failed", error: "Remote worker stopped without a final result. Inspect its worktree before retrying." };
			writeJsonFile(stateFile, failed);
			return failed;
		}
		return state;
	}
	if (input.action === "start") {
		const release = acquirePidLockSync(`${stateFile}.lock`, { timeoutMs: 5000 });
		try {
			const requestHash = digest(JSON.stringify(input.request));
			if (fs.existsSync(stateFile)) {
				const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
				if (state.requestHash !== requestHash) throw new Error("Remote operation ID was reused with different input.");
				return state;
			}
			const workspace = ownedWorkspace(cwd, input.request.runId);
			if (!fs.existsSync(workspace)) throw new Error("Prepare the remote task worktree first.");
			writeJsonFile(path.join(directory, `${id}.request.json`), { ...input.request, cwd: workspace });
			writeJsonFile(stateFile, { status: "starting", requestHash });
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--cwd", cwd, "--execute", id], { detached: true, stdio: "ignore", windowsHide: true });
			await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
			child.unref();
			return { status: "starting", requestHash };
		} finally { release(); }
	}
	if (input.action === "cancel") {
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		if (!["starting", "running"].includes(state.status)) return state;
		if (!state.pid) throw new Error("Remote worker is starting; retry cancellation after it records its identity.");
		const commandLine = fs.readFileSync(`/proc/${state.pid}/cmdline`, "utf8");
		if (!commandLine.split("\0").includes(id) || !commandLine.includes("remote-worker.mjs")) throw new Error("Remote process identity could not be verified.");
		process.kill(state.pid, "SIGTERM");
		return { ...state, cancellationRequested: true };
	}
	throw new Error("Unknown remote action.");
}

async function runJob(cwd, id) {
	const directory = storage(cwd);
	const stateFile = path.join(directory, `${id}.json`);
	const request = JSON.parse(fs.readFileSync(path.join(directory, `${id}.request.json`), "utf8"));
	const previous = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const release = acquirePidLockSync(path.join(directory, `${request.runId}.active.lock`), { timeoutMs: 5000, staleAgeMs: Infinity, holder: /node/i });
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Remote operation cancelled."));
	process.once("SIGTERM", abort);
	writeJsonFile(stateFile, { ...previous, status: "running", pid: process.pid });
	try {
		const before = workspaceRevision(request.cwd);
		let result;
		if (request.kind === "verify") {
			const checks = [];
			for (const args of request.commands) {
				const checked = await runCheck(args, { cwd: request.cwd, signal: controller.signal });
				checks.push({ ...checked, output: redact(checked.output).slice(-32000), host: "remote", at: new Date().toISOString() });
			}
			result = { checks };
		} else {
			const runner = new AgentRunner();
			try { result = await runner.call(request.agent, { ...request, signal: controller.signal }); }
			finally { await runner.close(); }
		}
		if (!request.write && workspaceRevision(request.cwd) !== before) throw new Error("Remote read-only operation changed project files.");
		if (request.write) {
			git(request.cwd, ["add", "-A", "--", "."]);
			git(request.cwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Duo", "-c", "user.email=duo@localhost", "commit", "--allow-empty", "--no-verify", "-m", "Duo remote task checkpoint"]);
			result.bundle = bundle(request.cwd, snapshot(request.cwd, `refs/duo/${request.runId}/output`));
		}
		writeJsonFile(stateFile, { ...previous, status: "completed", result });
	} catch (error) {
		writeJsonFile(stateFile, { ...previous, status: controller.signal.aborted ? "cancelled" : "failed", error: redact(error.message), worktree: request.cwd });
	} finally {
		release();
		process.removeListener("SIGTERM", abort);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	if (cwdIndex === -1 || !args[cwdIndex + 1]) throw new Error("An explicit --cwd is required.");
	const cwd = fs.realpathSync(args[cwdIndex + 1]);
	if (args.includes("--execute")) {
		const id = identifier(args[args.indexOf("--execute") + 1]);
		try { await runJob(cwd, id); }
		catch (error) {
			const stateFile = path.join(storage(cwd), `${id}.json`);
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			writeJsonFile(stateFile, { ...state, status: "failed", error: redact(error.message) });
		}
		return;
	}
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > 36 * 1024 * 1024) throw new Error("Remote request is too large.");
	}
	console.log(JSON.stringify(await remoteRequest(cwd, JSON.parse(input))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.log(JSON.stringify({ error: redact(error.message) })); process.exitCode = 1; });
}

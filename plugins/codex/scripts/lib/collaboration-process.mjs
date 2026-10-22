import { spawn } from "node:child_process";
import { resolveExecutable, terminateProcessTree } from "./process.mjs";

export function execute(command, args = [], options = {}) {
	return new Promise((resolve, reject) => {
		const env = options.env ?? process.env;
		let target;
		try {
			options.signal?.throwIfAborted();
			target = resolveExecutable(command, args, env);
		} catch (error) {
			reject(error);
			return;
		}
		const child = spawn(target[0], target[1], {
			cwd: options.cwd, env, shell: false, windowsHide: true,
			detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stdout = "";
		let stderr = "";
		let failure = null;
		let escalation;
		const limit = options.maxOutput ?? 4 * 1024 * 1024;
		const stop = (error) => {
			failure ??= error;
			if (child.pid && child.exitCode === null) {
				try { if (!terminateProcessTree(child.pid).delivered) child.kill(); } catch (cause) { failure = cause; child.kill(); }
				if (!escalation && process.platform !== "win32") escalation = setTimeout(() => {
					try { process.kill(-child.pid, "SIGKILL"); }
					catch (cause) { if (cause.code !== "ESRCH") failure = cause; }
				}, 3000);
			}
		};
		const abort = () => stop(options.signal.reason ?? new Error("Cancelled."));
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop(new Error("Operation timed out; inspect the checkpoint before retrying.")), options.timeoutMs ?? 30 * 60 * 1000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (Buffer.byteLength(stdout) > limit) stop(new Error("Process output exceeded its configured limit."));
			else options.onOutput?.(chunk.toString());
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (Buffer.byteLength(stderr) > limit) stop(new Error("Process error output exceeded its configured limit."));
		});
		child.on("error", (error) => { failure ??= error; });
		child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(escalation);
			options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else resolve({ status: code ?? 1, signal, stdout, stderr });
		});
		child.stdin.end(options.input ?? "");
	});
}

export function assertLaunchable(args) {
	try { resolveExecutable(args[0], args.slice(1)); }
	catch (error) { throw Object.assign(new Error(`${error.message} For a Node.js tool such as tsc, eslint, or pnpm, write the check as "npx ${args[0]} ..." instead.`), { status: 400 }); }
}

export async function runCheck(args, options = {}) {
	try {
		const result = await execute(args[0], args.slice(1), { ...options, timeoutMs: options.timeoutMs ?? 10 * 60 * 1000 });
		return { args, status: result.status === 0 ? "passed" : "failed", exitCode: result.status, output: `${result.stdout}\n${result.stderr}` };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return { args, status: "failed", exitCode: null, output: `The check could not run: ${error.message}` };
	}
}

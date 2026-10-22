import { spawnSync } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

export function resolveExecutable(command, args = [], env = process.env) {
	if (command === "node") return [process.execPath, args];
	if (process.platform !== "win32") return [command, args];
	if (command === "npm" || command === "npx") {
		const script = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", `${command}-cli.js`);
		if (fs.existsSync(script)) return [process.execPath, [script, ...args]];
	}
	if (path.isAbsolute(command)) {
		if (/\.(cmd|bat)$/i.test(command)) throw new Error("Use a native executable or node script instead of a batch file.");
		return [command, args];
	}
	const searchPath = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	for (const entry of searchPath.split(path.delimiter)) {
		const directory = entry.replace(/^"|"$/g, "");
		if (!directory) continue;
		for (const extension of [".exe", ".com"]) {
			const candidate = path.join(directory, `${command}${extension}`);
			if (fs.existsSync(candidate)) return [candidate, args];
		}
		const shim = command === "codex" ? ["@openai", "codex", "bin", "codex.js"] : command === "claude" ? ["@anthropic-ai", "claude-code", "cli.js"] : null;
		if (shim) {
			const script = path.join(directory, "node_modules", ...shim);
			if (fs.existsSync(script)) return [process.execPath, [script, ...args]];
		}
		if ([".cmd", ".bat"].some((extension) => fs.existsSync(path.join(directory, `${command}${extension}`)))) {
			throw new Error(`Cannot safely launch the ${command} batch wrapper. Use its native executable or Node.js entry point.`);
		}
	}
	return [command, args];
}

export function runCommand(command, args = [], options = {}) {
  if (options.shell) throw new Error("Implicit shell execution is not supported. Invoke an explicit executable with separate arguments.");
  const [target, targetArgs] = resolveExecutable(command, args, options.env ?? process.env);
  const result = spawnSync(target, targetArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout ?? 5 * 60 * 1000,
    shell: false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function processMatches(pid, pattern) {
  if (!isPidAlive(pid)) {
    return false;
  }
  if (process.platform === "linux") {
    try {
      return pattern.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return true;
    }
  }
  const result = process.platform === "win32"
    ? runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 10000 })
    : runCommand("ps", ["-p", String(pid), "-o", "comm="], { timeout: 10000 });
  if (result.error || result.status !== 0) {
    return true;
  }
  return pattern.test(result.stdout);
}

export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code !== "ESRCH";
  }
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

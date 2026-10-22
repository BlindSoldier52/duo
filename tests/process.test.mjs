import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { binaryAvailable, resolveExecutable, runCommand, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, shell: options.shell };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    shell: false
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("runCommand preserves argument boundaries and shell metacharacters literally", () => {
	const values = ["two words", 'a "quoted" value', "& | > < ^ %PATH% $(not-a-command)"];
	const result = runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...values]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.error, null);
	assert.deepEqual(JSON.parse(result.stdout), values);
	assert.throws(() => runCommand(process.execPath, ["--version"], { shell: true }), /Implicit shell execution is not supported/);
});

test("native CLI probes preserve npm-style Codex installation support", () => {
	const directory = makeTempDir("duo native cli ");
	installFakeCodex(directory);
	const env = buildEnv(directory);
	const result = binaryAvailable("codex", ["--version"], { env });
	assert.equal(result.available, true, result.detail);
	assert.match(result.detail, /fake-codex|codex-cli/);
});

test("Windows executable resolution accepts quoted PATH entries and respects native/Node entry points", { skip: process.platform !== "win32" }, () => {
	const directory = makeTempDir("duo quoted path ");
	installFakeCodex(directory);
	const env = { Path: `"${directory}"` };
	const [command, args] = resolveExecutable("codex", ["app-server"], env);
	assert.equal(command, process.execPath);
	assert.deepEqual(args, [path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js"), "app-server"]);
	assert.throws(() => resolveExecutable(path.join(directory, "codex.cmd"), [], env), /instead of a batch file/);
	assert.equal(resolveExecutable("npm", ["--version"], process.env)[0], process.execPath);
});

test("an unsupported earlier Windows batch wrapper cannot silently select another installation", { skip: process.platform !== "win32" }, () => {
	const first = makeTempDir("duo unsupported wrapper ");
	const second = makeTempDir("duo supported wrapper ");
	fs.writeFileSync(path.join(first, "codex.cmd"), "@echo off\r\nexit /b 1\r\n");
	installFakeCodex(second);
	assert.throws(() => resolveExecutable("codex", [], { PATH: `${first}${path.delimiter}${second}` }), /Cannot safely launch/);
});

test("CLI checks and direct App Server initialization run with deprecations treated as errors", () => {
	const directory = makeTempDir("duo process lifecycle ");
	installFakeCodex(directory);
	const processUrl = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
	const serverUrl = new URL("../plugins/codex/scripts/lib/app-server.mjs", import.meta.url).href;
	const source = `
		import assert from "node:assert/strict";
		import { runCommand, binaryAvailable } from ${JSON.stringify(processUrl)};
		import { CodexAppServerClient } from ${JSON.stringify(serverUrl)};
		const result = runCommand(process.execPath, ["--version"]);
		assert.equal(result.status, 0);
		assert.equal(result.error, null);
		assert.equal(binaryAvailable("codex", ["--version"]).available, true);
		const client = await CodexAppServerClient.connect(process.cwd(), { disableBroker: true });
		assert.equal(client.transport, "direct");
		await client.close();
		console.log("Native process lifecycle verified.");
	`;
	const result = spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", source], {
		cwd: directory, env: buildEnv(directory), encoding: "utf8", windowsHide: true, timeout: 10000
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Native process lifecycle verified/);
	assert.doesNotMatch(result.stderr, /DEP0190/);
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { installDuo } from "../scripts/install-duo.mjs";
import { createDuoTempDir, resolveDuoHome, resolveDuoStateDir } from "../plugins/codex/scripts/lib/duo-paths.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { CollaborationStore } from "../plugins/codex/scripts/lib/collaboration-state.mjs";
import { acquirePidLockSync } from "../plugins/codex/scripts/lib/lockfile.mjs";

function context(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-install-test-"));
	const home = path.join(root, "app data", "duo");
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	const previous = process.env.DUO_HOME;
	process.env.DUO_HOME = home;
	t.after(() => { if (previous === undefined) delete process.env.DUO_HOME; else process.env.DUO_HOME = previous; });
	return { root, home, cwd };
}

test("Duo paths use Windows AppData and support an explicit isolated data directory", () => {
	const base = path.join(os.tmpdir(), "duo-path-fixture");
	assert.equal(resolveDuoHome({ APPDATA: base }, "win32"), path.join(base, "duo"));
	assert.equal(resolveDuoHome({ LOCALAPPDATA: base }, "win32"), path.join(base, "duo"));
	assert.equal(resolveDuoHome({ XDG_DATA_HOME: base }, "linux"), path.join(base, "duo"));
	assert.equal(resolveDuoHome({ DUO_HOME: base }, "win32"), base);
	assert.throws(() => resolveDuoHome({ DUO_HOME: "relative" }), /absolute path/);
});

test("installation is self-contained and runs from its data directory without the source checkout on its module paths", (t) => {
	const { home, cwd } = context(t);
	const installed = installDuo({ home, link: false });
	assert.equal(installed.app, path.join(home, "app"));
	assert.equal(fs.existsSync(installed.guide), true);
	assert.equal(fs.existsSync(path.join(installed.app, "node_modules")), false);
	assert.equal(fs.existsSync(path.join(installed.app, ".git")), false);
	assert.equal(fs.existsSync(path.join(installed.app, "tests")), false);
	const manifest = JSON.parse(fs.readFileSync(path.join(installed.app, "package.json"), "utf8"));
	assert.equal(manifest.devDependencies, undefined);
	assert.equal(manifest.bin.duo, "duo.mjs");
	const result = spawnSync(process.execPath, [path.join(installed.app, "duo.mjs"), "help"], { cwd, encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Duo — Codex/);
	const entry = pathToFileURL(path.join(installed.app, "plugins/codex/scripts/lib/web-server.mjs")).href;
	const code = `import assert from 'node:assert/strict'; const {startWeb}=await import(${JSON.stringify(entry)}); const app=await startWeb({cwd:process.cwd(),port:0}); try { assert.equal((await fetch(app.url)).status,200); console.log('installed-http-ok'); } finally { await app.close(); }`;
	const web = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, env: { ...process.env, DUO_HOME: home }, encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(web.status, 0, web.stderr);
	assert.equal(web.stdout.trim(), "installed-http-ok");
	assert.equal(fs.existsSync(resolveDuoStateDir(cwd)), true);
});

test("installation copies every distributed document and README links resolve inside the installed app", (t) => {
	const { home } = context(t);
	const installed = installDuo({ home, link: false });
	for (const name of ["README.md", "guide.md", "plan.md", "AGENT_RULES.template.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "SECURITY.md"]) {
		assert.equal(fs.existsSync(path.join(installed.app, name)), true, name);
	}
	for (const name of fs.readdirSync(new URL("../docs", import.meta.url)).filter((entry) => entry.endsWith(".md"))) {
		assert.equal(fs.existsSync(path.join(installed.app, "docs", name)), true, `docs/${name}`);
	}
	const readme = fs.readFileSync(path.join(installed.app, "README.md"), "utf8");
	for (const [, target] of readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
		if (/^[a-z]+:/i.test(target)) continue;
		assert.equal(fs.existsSync(path.join(installed.app, target)), true, `README link ${target}`);
	}
});

test("updating an installed application preserves state and keeps the previous application as a backup", (t) => {
	const { home } = context(t);
	const original = installDuo({ home, link: false });
	fs.mkdirSync(original.state, { recursive: true });
	const state = path.join(original.state, "synthetic-session.json");
	fs.writeFileSync(state, "Synthetic persistent state\n");
	const updated = installDuo({ home, link: false });
	assert.ok(updated.backup.startsWith(path.join(home, "backups") + path.sep));
	assert.equal(fs.existsSync(path.join(updated.backup, "duo.mjs")), true);
	assert.equal(fs.readFileSync(state, "utf8"), "Synthetic persistent state\n");
	assert.equal(fs.existsSync(path.join(updated.app, "plugins/codex/prompts/collaboration-rules.md")), true);
});

test("an active coordinator prevents an application update without stopping it or replacing its files", (t) => {
	const { home, cwd } = context(t);
	const installed = installDuo({ home, link: false });
	const store = new CollaborationStore(cwd);
	t.after(() => store.close());
	assert.throws(() => installDuo({ home, link: false }), /Stop running Duo coordinators/);
	assert.equal(fs.existsSync(path.join(installed.app, "duo.mjs")), true);
	assert.equal(fs.readFileSync(path.join(store.directory, "coordinator.lock"), "utf8"), String(process.pid));
});

test("legacy collaboration state is copied once into AppData, originals remain, and current state is never overwritten", (t) => {
	const { home, cwd } = context(t);
	const legacy = path.join(resolveStateDir(cwd), "collaborations");
	const old = new CollaborationStore(cwd, legacy);
	const id = randomUUID();
	old.save({ id, task: "Synthetic migration fixture", phase: "awaiting_user" });
	old.close();
	const store = new CollaborationStore(cwd);
	assert.ok(store.directory.startsWith(home + path.sep));
	assert.equal(store.read(id).task, "Synthetic migration fixture");
	assert.equal(fs.existsSync(path.join(legacy, `${id}.json`)), true);
	assert.throws(() => new CollaborationStore(cwd, legacy), /already running/);
	store.save({ ...store.read(id), task: "Updated after migration" });
	store.close();
	const restarted = new CollaborationStore(cwd);
	t.after(() => restarted.close());
	assert.equal(restarted.read(id).task, "Updated after migration");
});

test("a still-running old coordinator blocks migration instead of allowing a second coordinator", (t) => {
	const { cwd } = context(t);
	const old = new CollaborationStore(cwd, path.join(resolveStateDir(cwd), "collaborations"));
	t.after(() => old.close());
	assert.throws(() => new CollaborationStore(cwd), (error) => error.code === "DUO_ALREADY_RUNNING");
	assert.equal(fs.readFileSync(path.join(old.directory, "coordinator.lock"), "utf8"), String(process.pid));
});

test("installation and coordinator startup cannot race, and transfer cache stays in the Duo data directory", (t) => {
	const { home, cwd } = context(t);
	fs.mkdirSync(home, { recursive: true });
	const release = acquirePidLockSync(path.join(home, "install.lock"), { timeoutMs: 100, staleAgeMs: Infinity });
	try { assert.throws(() => new CollaborationStore(cwd), (error) => error.code === "DUO_INSTALL_BUSY"); }
	finally { release(); }
	const cache = createDuoTempDir("synthetic-test-");
	assert.ok(cache.startsWith(path.join(home, "cache") + path.sep));
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDuoHome } from "../plugins/codex/scripts/lib/duo-paths.mjs";
import { acquirePidLockSync } from "../plugins/codex/scripts/lib/lockfile.mjs";
import { processMatches, runCommandChecked } from "../plugins/codex/scripts/lib/process.mjs";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const FILES = [
	"duo.mjs", "README.md", "guide.md", "plan.md", "AGENT_RULES.template.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "SECURITY.md",
	"scripts/install-duo.mjs", "plugins/codex/.claude-plugin/plugin.json",
	"plugins/codex/prompts/collaboration-rules.md",
	"plugins/codex/web/index.html", "plugins/codex/web/app.js", "plugins/codex/web/styles.css"
];

function copyFile(source, target) {
	if (!fs.lstatSync(source).isFile()) throw new Error(`Installation source must be a regular file: ${source}`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
}

function pruneBackups(directory, keep = 3) {
	if (!fs.existsSync(directory)) return;
	const old = fs.readdirSync(directory).filter((name) => /^app-\d+-/.test(name)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])).slice(keep);
	for (const name of old) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
}

function assertStopped(home) {
	const directory = path.join(home, "state");
	if (!fs.existsSync(directory)) return;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const lock = path.join(directory, entry.name, "collaborations", "coordinator.lock");
		if (!fs.existsSync(lock)) continue;
		const pid = Number(fs.readFileSync(lock, "utf8").trim());
		const writtenBeforeBoot = fs.statSync(lock).mtimeMs < Date.now() - os.uptime() * 1000 - 60000;
		if (!writtenBeforeBoot && processMatches(pid, /node/i)) throw new Error("Stop running Duo coordinators before updating the installed application. No process was stopped.");
	}
}

export function installDuo({ source = SOURCE, home = resolveDuoHome(), link = true } = {}) {
	if (!path.isAbsolute(home)) throw new Error("The installation directory must be an absolute path.");
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const release = acquirePidLockSync(path.join(home, "install.lock"), { timeoutMs: 100, staleAgeMs: Infinity, failIfBusy: true, holder: /node/i });
	let staging;
	let backup;
	const target = path.join(home, "app");
	try {
		assertStopped(home);
		staging = fs.mkdtempSync(path.join(home, ".install-"));
		for (const name of FILES) copyFile(path.join(source, name), path.join(staging, name));
		for (const name of fs.readdirSync(path.join(source, "plugins/codex/scripts/lib"))) {
			if (name.endsWith(".mjs")) copyFile(path.join(source, "plugins/codex/scripts/lib", name), path.join(staging, "plugins/codex/scripts/lib", name));
		}
		for (const name of ["remote-worker.mjs", "app-server-broker.mjs"]) copyFile(path.join(source, "plugins/codex/scripts", name), path.join(staging, "plugins/codex/scripts", name));
		for (const name of fs.readdirSync(path.join(source, "docs"))) {
			if (name.endsWith(".md")) copyFile(path.join(source, "docs", name), path.join(staging, "docs", name));
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
		const { name, version, description, license, engines, type, bin } = manifest;
		fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify({ name, version, description, license, engines, type, bin, private: true, scripts: { web: "node duo.mjs web", "install-duo": "node scripts/install-duo.mjs" } }, null, 2)}\n`);
		fs.chmodSync(path.join(staging, "duo.mjs"), 0o755);
		if (fs.existsSync(target)) {
			const backups = path.join(home, "backups");
			fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
			backup = path.join(backups, `app-${Date.now()}-${path.basename(staging)}`);
			try { fs.renameSync(target, backup); }
			catch (error) {
				if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
				throw new Error(`The installed copy at ${target} is in use. Close any terminal, editor, or Explorer window open inside it, stop Duo, and run the installer again.`, { cause: error });
			}
		}
		try { fs.renameSync(staging, target); }
		catch (error) {
			if (backup) fs.renameSync(backup, target);
			throw error;
		}
		staging = null;
		pruneBackups(path.join(home, "backups"));
		if (link) {
			try { runCommandChecked("npm", ["link", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"], { cwd: target }); }
			catch (error) { throw new Error(`Duo was copied to ${target}, but registering the command failed. Run npm link --offline --ignore-scripts --no-audit --no-fund --omit=dev in that directory. ${error.message}`, { cause: error }); }
		}
		return { home, app: target, guide: path.join(target, "guide.md"), state: path.join(home, "state"), backup };
	} catch (error) {
		if (staging) error.message += ` Incomplete installation preserved at ${staging}.`;
		throw error;
	} finally { release(); }
}

export function printInstallation() {
	const installed = installDuo();
	console.log(`Duo installed\nApplication: ${installed.app}\nState: ${installed.state}\nGuide: ${installed.guide}\nRun duo web from your project folder.`);
	if (installed.backup) console.log(`Previous application preserved: ${installed.backup}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { printInstallation(); }
	catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

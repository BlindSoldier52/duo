import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "./state.mjs";
import { acquirePidLockSync } from "./lockfile.mjs";
import { writeJsonFile } from "./fs.mjs";
import { AGENTS, fault } from "./collaboration-protocol.mjs";
import { resolveDuoHome, resolveDuoStateDir } from "./duo-paths.mjs";

const NODE_PROCESS = /node/i;

export function normalizeRun(run) {
	if (Object.hasOwn(run, "operation")) {
		run.operations = run.operation ? { [run.operation.agent]: run.operation } : {};
		delete run.operation;
	}
	if (Object.hasOwn(run, "modelPassCount")) {
		const [phase, agent] = String(run.modelPassPhase ?? "").split(":");
		run.passes = agent && run.modelPassCount ? { [agent]: { phase, count: run.modelPassCount } } : {};
		delete run.modelPassCount;
		delete run.modelPassPhase;
	}
	if (Object.hasOwn(run, "cursor")) {
		run.done = AGENTS.slice(0, run.cursor);
		delete run.cursor;
	}
	run.operations ??= {};
	run.passes ??= {};
	run.done ??= [];
	run.context ??= {};
	run.queue = (run.queue ?? []).map(({ chatOnly, ...item }) => ({ change: item.change ?? chatOnly === false, ...item }));
	return run;
}

export class CollaborationStore {
	constructor(cwd, directory) {
		this.directory = directory ?? path.join(resolveDuoStateDir(cwd), "collaborations");
		fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		let releaseInstall;
		try {
			if (!directory) {
				try { releaseInstall = acquirePidLockSync(path.join(resolveDuoHome(), "install.lock"), { timeoutMs: 1000, staleAgeMs: Infinity, holder: NODE_PROCESS }); }
				catch (error) {
					if (!/Timed out waiting for lock/.test(error.message)) throw error;
					throw Object.assign(fault("Duo is being installed or updated. Wait for installation to finish before starting a coordinator.", 503), { code: "DUO_INSTALL_BUSY", cause: error });
				}
			}
			const legacy = path.join(resolveStateDir(cwd), "collaborations");
			if (!directory && legacy !== this.directory && fs.existsSync(legacy)) {
				this.releaseLegacy = acquirePidLockSync(path.join(legacy, "coordinator.lock"), { timeoutMs: 100, staleAgeMs: Infinity, failIfBusy: true, holder: NODE_PROCESS });
			}
			this.release = acquirePidLockSync(path.join(this.directory, "coordinator.lock"), { timeoutMs: 100, staleAgeMs: Infinity, failIfBusy: true, holder: NODE_PROCESS });
			if (this.releaseLegacy) {
				for (const name of fs.readdirSync(legacy).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
					if (!fs.lstatSync(path.join(legacy, name)).isFile()) throw new Error("Legacy collaboration records must be regular files; migration stopped.");
					try { fs.copyFileSync(path.join(legacy, name), path.join(this.directory, name), fs.constants.COPYFILE_EXCL); }
					catch (error) { if (error.code !== "EEXIST") throw error; }
				}
			}
		} catch (error) {
			this.close();
			if (error.code !== "LOCK_BUSY") throw error;
			throw Object.assign(fault("Duo is already running for this workspace. Use the existing instance or stop it before starting another. Choosing a different port does not allow a second coordinator.", 409), { code: "DUO_ALREADY_RUNNING", cause: error });
		} finally { releaseInstall?.(); }
	}

	file(id) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw fault("Invalid collaboration ID.");
		return path.join(this.directory, `${id}.json`);
	}

	read(id) {
		try { return normalizeRun(JSON.parse(fs.readFileSync(this.file(id), "utf8"))); }
		catch (error) {
			if (error.code === "ENOENT") throw fault("Collaboration not found.", 404);
			throw error;
		}
	}

	list() {
		const runs = [];
		for (const name of fs.readdirSync(this.directory).filter((item) => /^[a-f0-9-]{36}\.json$/.test(item))) {
			try { runs.push(this.read(name.slice(0, -5))); }
			catch (error) { this.warn(name, error); }
		}
		return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	warn(name, error) {
		this.skipped ??= new Set();
		if (this.skipped.has(name)) return;
		this.skipped.add(name);
		process.stderr.write(`Skipping unreadable conversation ${name}: ${error.message}\n`);
	}

	save(run) {
		run.updatedAt = new Date().toISOString();
		writeJsonFile(this.file(run.id), run);
		return run;
	}

	create(config) {
		return this.save({
			id: randomUUID(), createdAt: new Date().toISOString(), ...config,
			phase: "discussing", stage: "proposal", done: [], round: 0,
			plan: "", planRevision: null, planVotes: {}, approval: null,
			revision: null, votes: {}, checks: [], sessions: {}, models: {},
			messages: [], events: [], queue: [], requests: {}, paused: false,
			operations: {}, passes: {}, context: {}, error: null
		});
	}

	notesFile() {
		return path.join(this.directory, "notes.json");
	}

	readNotes() {
		try { return JSON.parse(fs.readFileSync(this.notesFile(), "utf8")); }
		catch (error) {
			if (error.code !== "ENOENT") this.warn("notes.json", error);
			return {};
		}
	}

	saveNotes(notes) {
		writeJsonFile(this.notesFile(), notes);
	}

	close() {
		this.release?.();
		this.release = null;
		this.releaseLegacy?.();
		this.releaseLegacy = null;
	}
}

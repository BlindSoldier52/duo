import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CollaborationStore } from "./collaboration-state.mjs";
import { agentPrompt } from "./collaboration-agents.mjs";
import { RemoteAgentRunner } from "./collaboration-remote.mjs";
import { AGENTS, digest, fault, redact, validateLanguage, validateModel, validateResponse } from "./collaboration-protocol.mjs";
import { isGitWorkspace, workspaceRevision, workspaceSnapshot, workspaceDiff } from "./collaboration-workspace.mjs";
import { assertLaunchable, runCheck } from "./collaboration-process.mjs";
import { runCommand } from "./process.mjs";
import { assertSnapshotWorkspace } from "./collaboration-git.mjs";

const TERMINAL = new Set(["completed", "rejected", "cancelled"]);
const ACTIVE = new Set(["discussing", "implementing", "reviewing", "verifying", "queued"]);
const STOPPED = new Set(["cancelled", "rejected", "cancelling", "needs_attention", "waiting_quota"]);
const MODES = ["medium", "skip-everything", "split"];
const EFFORTS = ["low", "medium", "high"];
const QUOTA = /quota|rate[ _-]?limit|usage[ _-]?limit|usage cap|too many requests/i;
const EVENT_LIMIT = 500;
const SNAPSHOT_LIMIT = 20;
const UNSAVED_EVENTS = new Set(["activity"]);
const STOP_WORDS = new Set(["stop", "stop all", "stop everything", "stop now", "halt", "opreste", "opreste tot", "opriti", "opriti tot", "opreste-te", "opriti-va"]);

export function isStopRequest(content) {
	const text = String(content ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.!?,;:]+/g, " ").replace(/\s+/g, " ").trim();
	return STOP_WORDS.has(text);
}

function halted() {
	const error = new Error("Stopped by user.");
	error.code = "HALT";
	return error;
}

const INSTRUCTIONS = {
	proposal: "Inspect the project on your own and propose an approach with a complete implementation plan. Put the proposal in message. Do not edit files.",
	draft: "Combine both proposals into one plan and resolve every open objection, including each blockingIssues entry from the reviews. Return the complete candidate plan in plan. Do not edit files.",
	planReview: "Review the exact current plan against the task and the repository. Approve it, or list each blocking problem in blockingIssues. Do not rewrite the plan or edit files.",
	implement: "Implement the approved plan completely. Preserve unrelated work and address peer findings and user feedback. The coordinator runs the configured checks; describe only verification you actually performed.",
	review: (run) => `Inspect the final implementation at revision ${run.revision} against the acceptance criteria. Coordinator check results: ${JSON.stringify(run.checks)}.${run.commands.length ? "" : " No automated checks were configured; inspect the artifacts directly and say so."}`,
	chat: (content) => `Answer this user message directly and briefly. It is a question, not a request to change the plan: ${content}`,
	change: (content) => `The user changed the task with this message. Acknowledge it briefly and say what the plan must change; the plan is revised next: ${content}`
};

function limit(value, name) {
	const number = Number(value ?? 12);
	if (!Number.isInteger(number) || number < 1 || number > 30) throw fault(`${name} limit must be between 1 and 30.`);
	return number;
}

function commandList(list) {
	const valid = Array.isArray(list) && list.length <= 20 && list.every((args) => Array.isArray(args) && args.length && args.length <= 64 && args.every((arg) => typeof arg === "string" && !arg.includes("\0")));
	if (!valid) throw fault("Verification commands must be arrays of executable names and arguments.");
	return list;
}

function model(value) {
	return validateModel(typeof value === "string" ? value.trim() : value);
}

function changedFiles(before, after) {
	if (!before) return null;
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].filter((name) => before[name] !== after[name]).sort();
}

async function settleAll(tasks) {
	const results = await Promise.allSettled(tasks);
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw failure.reason;
}

export class Collaboration extends EventEmitter {
	constructor(cwd, options = {}) {
		super();
		this.setMaxListeners(0);
		this.cwd = cwd;
		this.workspaceKind = isGitWorkspace(cwd) ? "git" : "folder";
		this.store = options.store ?? new CollaborationStore(cwd, options.directory);
		this.runner = options.runner ?? new RemoteAgentRunner();
		this.running = new Map();
		this.pending = new Set();
		this.closed = false;
		this.snapshots = new Map();
		try { this.recover(); }
		catch (error) { this.store.close(); throw error; }
	}

	recover() {
		for (const run of this.store.list()) {
			if (!ACTIVE.has(run.phase) && run.phase !== "cancelling") continue;
			run.phase = "needs_attention";
			run.error = "Coordinator restarted. Inspect any interrupted operation before resuming.";
			this.store.save(run);
		}
	}

	get(id) { return this.store.read(id); }
	list() { return this.store.list(); }
	artifacts(id) { return workspaceDiff(this.cwd, id ? this.get(id).baseFiles : undefined); }

	persist(run, type, detail = {}) {
		run.eventCounter = (run.eventCounter ?? run.events.at(-1)?.id ?? 0) + 1;
		const event = { id: run.eventCounter, at: new Date().toISOString(), type, ...detail };
		run.events.push(event);
		if (run.events.length > EVENT_LIMIT) run.events.splice(0, run.events.length - EVENT_LIMIT);
		if (!UNSAVED_EVENTS.has(type)) this.store.save(run);
		this.emit("event", { runId: run.id, ...event });
		return run;
	}

	message(run, sender, recipient, content, extra = {}) {
		run.messages.push({ id: randomUUID(), at: new Date().toISOString(), sender, recipient, content: redact(content), ...extra });
		this.persist(run, "message", { messageId: run.messages.at(-1).id });
	}

	create(input) {
		if (this.closed) throw fault("Coordinator is shutting down.", 503);
		const task = String(input.task ?? "").trim();
		if (!task || task.length > 64000) throw fault("Enter a task of up to 64,000 characters.");
		const mode = input.mode ?? "medium";
		if (!MODES.includes(mode)) throw fault("Invalid collaboration mode.");
		const policy = mode === "split" ? input.policy : mode;
		if (!["medium", "skip-everything"].includes(policy)) throw fault("Select a split-mode autonomy policy.");
		const effort = input.effort || null;
		if (effort !== null && !EFFORTS.includes(effort)) throw fault("Choose low, medium, or high effort, or leave the CLI default.");
		const modelPolicy = input.modelPolicy ?? "adaptive";
		if (!["adaptive", "fixed"].includes(modelPolicy)) throw fault("Choose adaptive or fixed model selection.");
		const commands = commandList(input.commands ?? []);
		const remoteCommands = commandList(input.remoteCommands ?? []);
		for (const args of commands) assertLaunchable(args);
		if (mode === "split") this.validateSplit(input);
		const codexModel = model(input.codexModel);
		const claudeModel = model(input.claudeModel);
		const workspace = workspaceSnapshot(this.cwd);
		this.workspaceKind = workspace.kind;
		const run = this.store.create({
			task: redact(task), criteria: redact(String(input.criteria ?? task)), cwd: this.cwd,
			mode, policy, maxRounds: limit(input.maxRounds, "Round"), maxPasses: limit(input.maxPasses, "Pass"),
			commands, remoteCommands, implementer: input.implementer === "claude" ? "claude" : "codex",
			codexModel, claudeModel, modelPolicy, effort, language: validateLanguage(input.language),
			windows: input.windows === undefined ? process.platform === "win32" : input.windows === true,
			activeModels: { codex: codexModel, claude: claudeModel }, modelHistory: [],
			remoteAgent: input.remoteAgent ?? "claude",
			remote: input.remote ? { alias: input.remote.alias, cwd: input.remote.cwd, worker: input.remote.worker } : null,
			workspaceKind: workspace.kind, baseFiles: workspace.kind === "folder" ? workspace.files : null,
			baseRevision: workspace.revision
		});
		this.message(run, "user", "both", task);
		this.start(run.id);
		return this.get(run.id);
	}

	validateSplit(input) {
		if (!this.runner.validateRemote) throw fault("Remote execution is not configured.");
		this.runner.validateRemote(input);
		if (!isGitWorkspace(this.cwd)) throw fault("VPS–computer synchronization currently requires a Git repository with an existing commit. Use Medium or Skip everything for a folder without Git.");
		const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: this.cwd });
		if (head.error) throw head.error;
		if (head.status !== 0) throw fault("VPS–computer synchronization requires a Git repository with an existing commit. Local tasks do not require a commit.");
		assertSnapshotWorkspace(this.cwd);
	}

	action(id, name, input = {}) {
		const run = this.running.get(id)?.run ?? this.get(id);
		const key = input.requestId;
		if (typeof key !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw fault("A valid requestId is required.");
		const fingerprint = digest(JSON.stringify({ name, ...input }));
		if (run.requests[key]) {
			if (run.requests[key] !== fingerprint) throw fault("Request ID was already used for another action.", 409);
			return run;
		}
		const handler = this.actions[name];
		if (!handler) throw fault("Unknown collaboration action.", 404);
		handler.call(this, run, input);
		run.requests[key] = fingerprint;
		this.persist(run, "action", { action: name });
		if (["approve", "revise", "resume", "message", "mode"].includes(name) || (name === "cancel" && run.phase === "cancelling")) this.start(id);
		return run;
	}

	get actions() {
		return {
			pause: this.pause, cancel: this.cancel, message: this.receive, revise: this.revise,
			approve: this.approve, reject: this.reject, resume: this.resume, language: this.setLanguage, mode: this.setMode
		};
	}

	pause(run) {
		if (TERMINAL.has(run.phase)) throw fault("This run has already ended.", 409);
		run.paused = true;
	}

	cancel(run) {
		if (TERMINAL.has(run.phase)) throw fault("This run has already ended.", 409);
		const remote = Object.values(run.operations).some((operation) => operation.remote);
		run.phase = this.running.has(run.id) || remote ? "cancelling" : "cancelled";
		this.running.get(run.id)?.controller.abort(new Error("Cancelled by user."));
	}

	receive(run, input) {
		if (!["codex", "claude", "both"].includes(input.recipient)) throw fault("Invalid message recipient.");
		const content = String(input.content ?? "").trim();
		if (!content || content.length > 64000) throw fault("Enter a message of up to 64,000 characters.");
		if (isStopRequest(content)) return this.halt(run, content);
		if (["cancelled", "rejected", "cancelling"].includes(run.phase)) throw fault("Create a new task after rejection or cancellation.", 409);
		const operations = Object.values(run.operations);
		if (!this.running.has(run.id) && operations.length) {
			if (operations.some((operation) => operation.write || operation.remote)) throw fault("Resume or cancel the unresolved operation before sending new instructions.", 409);
			run.operations = {};
			run.passes = {};
		}
		this.message(run, "user", input.recipient, content, input.change ? { change: true } : {});
		run.queue.push({ content: redact(content), recipients: input.recipient === "both" ? [...AGENTS] : [input.recipient], change: input.change === true });
		if (run.phase === "completed") run.phase = "discussing";
	}

	halt(run, content) {
		if (TERMINAL.has(run.phase) || run.phase === "cancelling") return;
		this.message(run, "user", "both", content, { halt: true });
		run.paused = true;
		run.queue = [];
		this.running.get(run.id)?.controller.abort(halted());
	}

	release(run) {
		for (const [agent, operation] of Object.entries(run.operations)) {
			if (operation.remote || (run.mode === "split" && run.remoteAgent === agent)) continue;
			if (operation.write) run.stage = "verify";
			delete run.operations[agent];
		}
	}

	revise(run, input) {
		this.requireIdle(run);
		if (typeof input.plan !== "string" || !input.plan.trim() || input.plan.length > 200000) throw fault("A non-empty plan is required.");
		if (input.planRevision !== run.planRevision) throw fault("The plan changed. Reload it before editing.", 409);
		run.plan = redact(input.plan);
		run.planRevision = digest(run.plan);
		Object.assign(run, { planVotes: {}, approval: null, round: 0, done: [], stage: "plan-review", phase: "discussing" });
		run.baseRevision = workspaceRevision(this.cwd);
	}

	approve(run, input) {
		this.requireIdle(run);
		if (run.phase !== "awaiting_user" || input.planRevision !== run.planRevision || !run.plan) throw fault("Only the current reviewed plan can be approved.", 409);
		if (!this.approved(run.planVotes, run.planRevision)) throw fault("Both agents must review this plan before implementation.", 409);
		if (workspaceRevision(this.cwd) !== run.baseRevision) throw fault("Workspace changed since plan review. Revise the plan before approval.", 409);
		run.approval = { revision: run.planRevision, at: new Date().toISOString(), by: "user" };
		Object.assign(run, { phase: "implementing", stage: "implement", round: 0 });
	}

	reject(run) {
		this.requireIdle(run);
		if (run.phase !== "awaiting_user" && run.phase !== "needs_attention") throw fault("There is no pending plan to reject.", 409);
		run.phase = "rejected";
	}

	resume(run) {
		if (TERMINAL.has(run.phase)) throw fault("This run has ended. Send a new message or start another task.", 409);
		if (run.phase === "cancelling") throw fault("Wait for cancellation to finish.", 409);
		for (const [agent, operation] of Object.entries(run.operations)) {
			if (!operation.write || (run.mode === "split" && run.remoteAgent === agent)) continue;
			delete run.operations[agent];
			run.stage = "verify";
		}
		if (run.stage === "review" && workspaceRevision(this.cwd) !== run.revision) run.stage = "verify";
		run.paused = false;
		run.error = null;
		if (run.phase !== "awaiting_user") run.phase = "discussing";
	}

	setLanguage(run, input) {
		this.requireIdle(run);
		if (["cancelled", "rejected", "cancelling"].includes(run.phase)) throw fault("Create a new task after rejection or cancellation.", 409);
		if (typeof input.language !== "string") throw fault("A response language is required.");
		run.language = validateLanguage(input.language);
		this.message(run, "user", "both", `Response language setting changed to ${JSON.stringify(run.language)}.`);
	}

	setMode(run, input) {
		this.requireIdle(run);
		if (!MODES.includes(input.mode)) throw fault("Invalid mode.");
		if (TERMINAL.has(run.phase)) throw fault("Create a new task after a run has ended.", 409);
		if (input.mode === "split" && run.mode !== "split") throw fault("Create a new split task to configure the VPS and its agent.");
		if (run.mode === "split" && input.mode !== "split") Object.assign(run, { sessions: {}, models: {}, context: {} });
		run.mode = input.mode;
		run.policy = input.mode === "split" ? run.policy : input.mode;
		run.passes = {};
		this.replan(run);
	}

	replan(run) {
		Object.assign(run, { approval: null, planVotes: {}, votes: {}, done: [], round: 0, phase: "discussing" });
		if (run.stage !== "proposal") run.stage = "draft";
		run.baseRevision = workspaceRevision(this.cwd);
	}

	requireIdle(run) {
		if (this.running.has(run.id)) throw fault("Pause and wait for the active operation to finish first.", 409);
		if (Object.keys(run.operations).length) throw fault("Resolve the interrupted operation before changing the plan or mode.", 409);
	}

	approved(votes, revision) {
		return AGENTS.every((agent) => votes[agent]?.revision === revision && votes[agent]?.verdict === "approve");
	}

	start(id) {
		if (this.closed || this.running.has(id)) return;
		const run = this.get(id);
		if (TERMINAL.has(run.phase) || run.paused) return;
		if (this.running.size) {
			this.pending.add(id);
			if (run.phase !== "cancelling") run.phase = "queued";
			this.persist(run, "queued");
			return;
		}
		if (run.phase === "queued") run.phase = "discussing";
		const entry = { run, controller: new AbortController(), promise: null };
		this.running.set(id, entry);
		entry.promise = this.drive(entry).catch((error) => { process.stderr.write(`Duo could not save conversation ${id}: ${error.message}\n`); });
	}

	async drive({ run, controller }) {
		try { await this.work(run, controller.signal); }
		catch (error) { this.fail(run, error, controller.signal); }
		finally {
			this.running.delete(run.id);
			this.persist(run, "idle");
			if (run.queue.length && !run.paused && !STOPPED.has(run.phase)) {
				if (run.phase === "completed") { run.phase = "discussing"; this.store.save(run); }
				this.pending.add(run.id);
			}
			this.startNext();
		}
	}

	fail(run, error, signal) {
		if (signal.reason?.code === "HALT" && !error.remoteUnconfirmed) {
			this.release(run);
			run.error = null;
			this.persist(run, "halted", { message: "Stopped by user. Press Resume or send new instructions and then Resume to continue." });
			return;
		}
		const cancelled = signal.aborted && signal.reason?.code !== "SHUTDOWN" && !error.remoteUnconfirmed;
		run.phase = cancelled ? "cancelled" : QUOTA.test(error.message) ? "waiting_quota" : "needs_attention";
		run.error = redact(error.message);
		this.persist(run, "error", { message: run.error });
	}

	startNext() {
		while (!this.closed && !this.running.size && this.pending.size) {
			const next = this.pending.values().next().value;
			this.pending.delete(next);
			this.start(next);
		}
	}

	active(run) {
		return !run.paused && !this.closed && !TERMINAL.has(run.phase) && run.phase !== "cancelling";
	}

	async work(run, signal) {
		if (run.phase === "cancelling") return this.cancelRemote(run);
		while (this.active(run)) {
			signal.throwIfAborted();
			if (run.queue.length) {
				if (!(await this.answer(run, signal))) return;
				continue;
			}
			if (run.phase === "awaiting_user") return;
			await this.advance(run, signal);
			this.persist(run, "state", { phase: run.phase, stage: run.stage });
		}
		if (run.phase === "cancelling") { run.phase = "cancelled"; this.persist(run, "state"); }
	}

	async cancelRemote(run) {
		for (const [agent, operation] of Object.entries(run.operations)) {
			if (!operation.remote) continue;
			await this.runner.cancel({ run, operation });
			delete run.operations[agent];
		}
		run.phase = "cancelled";
		this.persist(run, "state");
	}

	async answer(run, signal) {
		const item = run.queue[0];
		const ask = async (agent) => {
			const instruction = item.change ? INSTRUCTIONS.change(item.content) : INSTRUCTIONS.chat(item.content);
			const response = await this.consult(run, agent, "chat", instruction, signal);
			if (!response) return;
			item.recipients = item.recipients.filter((recipient) => recipient !== agent);
			this.store.save(run);
		};
		await this.readOnly(() => settleAll(item.recipients.map(ask)));
		if (item.recipients.length) return false;
		run.queue.shift();
		if (item.change) this.replan(run);
		else if (run.stage === "done") run.phase = "completed";
		this.store.save(run);
		return true;
	}

	async advance(run, signal) {
		const stages = { proposal: this.propose, draft: this.draft, "plan-review": this.reviewPlan, implement: this.implement, verify: this.verify, review: this.review };
		const stage = stages[run.stage];
		if (!stage) throw new Error(`Unknown stage: ${run.stage}`);
		if (["proposal", "draft", "plan-review"].includes(run.stage) && workspaceRevision(this.cwd) !== run.baseRevision) {
			throw new Error("Workspace changed during planning. Revise the plan against the new sources before continuing.");
		}
		await stage.call(this, run, signal);
	}

	async propose(run, signal) {
		if (await this.everyone(run, "proposal", INSTRUCTIONS.proposal, signal)) run.stage = "draft";
	}

	async draft(run, signal) {
		if (run.round >= run.maxRounds) throw new Error("Discussion round limit reached without agreement. Inspect the transcript and revise or increase the limit in a new run.");
		const response = await this.readOnly(() => this.consult(run, run.implementer, "draft", INSTRUCTIONS.draft, signal));
		if (!response) return;
		if (!response.plan.trim()) throw new Error("The candidate plan was empty.");
		run.plan = redact(response.plan);
		run.planRevision = digest(run.plan);
		Object.assign(run, { planVotes: {}, done: [], stage: "plan-review", round: run.round + 1 });
	}

	async reviewPlan(run, signal) {
		const vote = (agent, response) => { run.planVotes[agent] = { verdict: response.verdict, revision: run.planRevision }; };
		if (!(await this.everyone(run, "plan-review", INSTRUCTIONS.planReview, signal, vote))) return;
		if (!this.approved(run.planVotes, run.planRevision)) { run.stage = "draft"; return; }
		Object.assign(run, { phase: run.policy === "medium" ? "awaiting_user" : "implementing", stage: "implement", round: 0 });
	}

	async implement(run, signal) {
		if (run.round >= run.maxRounds) throw new Error("Correction round limit reached without joint approval.");
		if (run.policy === "medium" && run.approval?.revision !== run.planRevision) throw new Error("User approval of this plan is required.");
		run.phase = "implementing";
		const response = await this.consult(run, run.implementer, "implement", INSTRUCTIONS.implement, signal, true);
		if (!response) return;
		run.round++;
		run.stage = "verify";
	}

	async verify(run, signal) {
		Object.assign(run, { phase: "verifying", votes: {}, checks: [], revision: workspaceRevision(this.cwd) });
		for (const args of run.commands) {
			if (run.paused) return;
			const check = await runCheck(args, { cwd: this.cwd, signal });
			run.checks.push({ ...check, output: redact(check.output).slice(-32000), revision: run.revision, host: "local", at: new Date().toISOString() });
			this.persist(run, "check", { status: check.status });
			if (workspaceRevision(this.cwd) !== run.revision) throw new Error("Verification changed project files. Inspect those changes before continuing.");
		}
		if (run.mode === "split" && run.remoteCommands.length) await this.verifyRemote(run, signal);
		Object.assign(run, { stage: "review", done: [] });
	}

	async verifyRemote(run, signal) {
		const agent = run.remoteAgent;
		const operation = run.operations[agent] ??= { id: randomUUID(), phase: "verify", agent, write: false, startedAt: new Date().toISOString() };
		this.persist(run, "operation", { agent, phase: "verify" });
		const checks = await this.runner.verify({
			cwd: this.cwd, run, signal, operation, operationId: operation.id,
			onCheckpoint: (patch) => { Object.assign(operation, patch); this.store.save(run); }
		});
		for (const check of checks) run.checks.push({ ...check, revision: run.revision });
		delete run.operations[agent];
		this.persist(run, "check", { host: "remote" });
	}

	async review(run, signal) {
		run.phase = "reviewing";
		if (workspaceRevision(this.cwd) !== run.revision) throw new Error("Workspace changed after verification. Resume to verify the new revision.");
		const vote = (agent, response) => { run.votes[agent] = { verdict: response.verdict, revision: run.revision }; };
		if (!(await this.everyone(run, "review", INSTRUCTIONS.review(run), signal, vote))) return;
		const passed = this.approved(run.votes, run.revision) && run.checks.every((check) => check.status === "passed") && workspaceRevision(this.cwd) === run.revision;
		Object.assign(run, passed ? { phase: "completed", stage: "done" } : { phase: "implementing", stage: "implement" });
	}

	async everyone(run, phase, instruction, signal, record) {
		const waiting = AGENTS.filter((agent) => !run.done.includes(agent));
		const ask = async (agent) => {
			const response = await this.consult(run, agent, phase, instruction, signal);
			if (!response) return;
			record?.(agent, response);
			run.done.push(agent);
			this.store.save(run);
		};
		await this.readOnly(() => settleAll(waiting.map(ask)));
		if (run.done.length < AGENTS.length) return false;
		run.done = [];
		return true;
	}

	async readOnly(task) {
		const before = workspaceRevision(this.cwd);
		const result = await task();
		if (workspaceRevision(this.cwd) !== before) throw new Error("Workspace changed during a read-only phase. Review the change before continuing.");
		return result;
	}

	async consult(run, agent, phase, instruction, signal, write = false) {
		while (true) {
			const response = await this.call(run, agent, phase, instruction, signal, write);
			if (!response.routing?.repeat) return response;
			if (run.paused || this.closed) return null;
		}
	}

	operation(run, agent, phase, instruction, write) {
		const pass = (run.passes[agent]?.phase === phase ? run.passes[agent].count : 0) + 1;
		if (pass > run.maxPasses) throw new Error("Agent pass limit reached. Inspect the transcript before starting another run with a different limit.");
		const current = this.snapshot();
		const memory = run.sessions[agent]
			? { changes: changedFiles(this.snapshots.get(run.context[agent]?.revision), current.files) }
			: { notes: this.notes(current.files) };
		const { prompt, context } = agentPrompt(run, agent, phase, instruction, write, memory);
		return {
			id: randomUUID(), agent, phase, write, pass, prompt, context: { ...context, revision: current.revision },
			startedAt: new Date().toISOString(), model: run.activeModels?.[agent] ?? run[`${agent}Model`] ?? null
		};
	}

	snapshot() {
		const current = workspaceSnapshot(this.cwd);
		this.snapshots.delete(current.revision);
		this.snapshots.set(current.revision, current.files);
		while (this.snapshots.size > SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value);
		return current;
	}

	notes(files) {
		return Object.entries(this.store.readNotes()).filter(([, note]) => note?.text).map(([agent, note]) => ({
			agent, at: note.at, text: note.text, changed: changedFiles(note.files, files)
		}));
	}

	remember(run, agent, operation, text) {
		if (!text?.trim()) return;
		const files = this.snapshots.get(operation.context?.revision) ?? this.snapshot().files;
		const notes = this.store.readNotes();
		notes[agent] = { text: redact(text.trim()), at: new Date().toISOString(), runId: run.id, files };
		this.store.saveNotes(notes);
		this.persist(run, "notes", { agent });
	}

	assertWorkspaceFree(run, write) {
		const busy = [...this.running.values()].some((entry) => entry.run.id !== run.id && Object.values(entry.run.operations).some((operation) => operation.write || write));
		if (busy) throw new Error("Another collaboration is using this workspace. Resume after it finishes.");
	}

	async call(run, agent, phase, instruction, signal, write = false) {
		this.assertWorkspaceFree(run, write);
		const operation = run.operations[agent] ?? this.operation(run, agent, phase, instruction, write);
		if (operation.phase !== phase) throw new Error("An unresolved operation must be reconciled before scheduling another one.");
		run.operations[agent] = operation;
		this.persist(run, "operation", { agent, phase, operationId: operation.id });
		const host = run.mode === "split" && run.remoteAgent === agent ? "remote" : "local";
		let reported = null;
		const result = await this.runner.call(agent, {
			cwd: this.cwd, prompt: operation.prompt, write, signal, phase, run, operation, operationId: operation.id,
			model: operation.model ?? null, effort: run.effort ?? null, session: run.sessions[agent], windows: run.windows === true,
			onCheckpoint: (patch) => { Object.assign(operation, patch); this.store.save(run); },
			onSession: ({ session, model: name }) => {
				run.sessions[agent] = session;
				if (name) { reported = name; run.models[agent] = name; }
				this.persist(run, "session", { agent });
			},
			onProgress: (progress) => {
				const text = typeof progress === "string" ? progress : progress?.message;
				if (text) this.persist(run, "activity", { agent, message: redact(text) });
			}
		});
		signal.throwIfAborted();
		const response = validateResponse(result.response);
		run.sessions[agent] = result.session ?? run.sessions[agent];
		run.models[agent] = result.model ?? reported;
		run.modelHistory.push({ operationId: operation.id, agent, phase, pass: operation.pass ?? 1, requested: operation.model ?? null, reported: run.models[agent], host, at: new Date().toISOString() });
		delete run.operations[agent];
		if (operation.context) run.context[agent] = operation.context;
		this.remember(run, agent, operation, response.notes);
		if (response.routing?.repeat) run.passes[agent] = { phase, count: operation.pass ?? 1 };
		else delete run.passes[agent];
		const content = phase === "proposal" && response.plan.trim() ? `${response.message}\n\n${response.plan}` : response.message;
		this.message(run, agent, phase === "chat" ? "user" : AGENTS.find((item) => item !== agent), content, {
			phase, verdict: response.verdict, blockingIssues: response.blockingIssues.map(redact),
			provisional: response.routing?.repeat === true, model: run.models[agent], requestedModel: operation.model ?? null, host
		});
		this.route(run, agent, phase, response.routing);
		return response;
	}

	route(run, agent, phase, routing) {
		if (routing?.model == null) return;
		if (run.modelPolicy !== "adaptive") {
			this.persist(run, "model-request-ignored", { agent, phase, model: routing.model, message: "Fixed model selection; the request was ignored." });
			return;
		}
		run.activeModels ??= { codex: run.codexModel, claude: run.claudeModel };
		run.activeModels[agent] = routing.model;
		this.persist(run, "model-selection", { agent, phase, model: routing.model, message: redact(routing.reason) });
	}

	async close() {
		this.closed = true;
		const shutdown = Object.assign(new Error("Coordinator shutting down. Resume from the saved checkpoint."), { code: "SHUTDOWN" });
		for (const entry of this.running.values()) entry.controller.abort(shutdown);
		await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
		await this.runner.close?.();
		this.store.close();
	}
}

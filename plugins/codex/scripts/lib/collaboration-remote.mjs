import { randomUUID } from "node:crypto";
import { AgentRunner } from "./collaboration-agents.mjs";
import { execute } from "./collaboration-process.mjs";
import { snapshot, bundle, applySnapshot } from "./collaboration-git.mjs";
import { fault } from "./collaboration-protocol.mjs";

function quote(value) { return `'${value.replace(/'/g, "'\\''")}'`; }

export class RemoteAgentRunner extends AgentRunner {
	validateRemote(input) {
		if (!["codex", "claude"].includes(input.remoteAgent ?? "claude")) throw fault("Choose which agent runs remotely.");
		const profile = input.remote;
		if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(profile.alias) ||
			![profile.cwd, profile.worker].every((value) => typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/.test(value))) {
			throw fault("Configure an SSH alias and absolute Linux paths for the remote project and installed worker.");
		}
	}

	async request(profile, input) {
		const command = `node ${quote(profile.worker)} --cwd ${quote(profile.cwd)}`;
		const result = await execute("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", profile.alias, command], {
			input: JSON.stringify(input), timeoutMs: 120000, maxOutput: 36 * 1024 * 1024
		});
		let response;
		try { response = JSON.parse(result.stdout); }
		catch { throw new Error(`SSH worker did not return JSON: ${result.stderr.slice(-1500)}`); }
		if (result.status !== 0 || response.error) throw new Error(response.error ?? result.stderr ?? "SSH request failed.");
		return response;
	}

	async prepare(options) {
		const run = options.run;
		if (options.operation?.remote) return options.operation.remote;
		const checkpoint = snapshot(options.cwd, `refs/duo/${run.id}/local`);
		const prepared = await this.request(run.remote, { action: "prepare", runId: run.id, bundle: bundle(options.cwd, checkpoint) });
		const remote = { base: checkpoint.revision, cwd: prepared.cwd };
		options.onCheckpoint?.({ remote });
		return remote;
	}

	async wait(options, request) {
		const { run, signal } = options;
		const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
		let id = options.operation?.job ?? options.operationId;
		let state = await this.request(run.remote, { action: "status", id });
		if (["failed", "cancelled"].includes(state.status)) {
			id = randomUUID();
			options.onCheckpoint?.({ job: id });
			state = { status: "missing" };
		}
		if (state.status === "missing") state = await this.request(run.remote, { action: "start", id, request });
		while (["starting", "running"].includes(state.status)) {
			if (Date.now() > deadline) throw new Error("Remote operation timed out. Its checkpoint and job ID are preserved for inspection.");
			if (signal?.aborted && state.pid) {
				await this.request(run.remote, { action: "cancel", id });
			}
			await new Promise((resolve) => setTimeout(resolve, 750));
			state = await this.request(run.remote, { action: "status", id });
		}
		if (state.status !== "completed") throw new Error(`${state.error ?? "Remote operation failed"}${state.worktree ? `; preserved worktree: ${state.worktree}` : ""}`);
		return state.result;
	}

	async call(agent, options) {
		if (options.run?.mode !== "split" || options.run.remoteAgent !== agent) return super.call(agent, options);
		try {
			const remote = await this.prepare(options);
			const result = await this.wait(options, {
				runId: options.run.id, agent, write: options.write,
				prompt: options.prompt.replace(`Workspace: ${options.cwd}`, `Workspace: ${remote.cwd}`) + "\nUse project-relative paths on this host; peer absolute paths may belong to the other machine.",
				model: options.model, effort: options.effort, session: options.session
			});
			if (result.bundle) applySnapshot(options.cwd, remote.base, result.bundle, options.run.id);
			options.signal?.throwIfAborted();
			return result;
		} catch (error) {
			if (options.signal?.aborted && !/cancelled/i.test(error.message)) error.remoteUnconfirmed = true;
			throw error;
		}
	}

	async verify(options) {
		try {
			await this.prepare(options);
			const result = await this.wait(options, { runId: options.run.id, kind: "verify", commands: options.run.remoteCommands, write: false });
			return result.checks;
		} catch (error) {
			if (options.signal?.aborted && !/cancelled/i.test(error.message)) error.remoteUnconfirmed = true;
			throw error;
		}
	}

	async cancel({ run, operation }) {
		const id = operation.job ?? operation.id;
		const deadline = Date.now() + 120000;
		let state = await this.request(run.remote, { action: "status", id });
		while (["starting", "running"].includes(state.status)) {
			if (Date.now() > deadline) throw new Error("Remote cancellation is still unconfirmed. The worker checkpoint has been preserved.");
			if (state.pid) await this.request(run.remote, { action: "cancel", id });
			await new Promise((resolve) => setTimeout(resolve, 750));
			state = await this.request(run.remote, { action: "status", id });
		}
	}
}

import fs from "node:fs";
import path from "node:path";
import { runCommandChecked, runCommand } from "./process.mjs";
import { createDuoTempDir } from "./duo-paths.mjs";
import { protectedPath } from "./collaboration-workspace.mjs";

export function git(cwd, args, options = {}) {
	return runCommandChecked("git", args, { cwd, shell: false, maxBuffer: 48 * 1024 * 1024, ...options }).stdout.trimEnd();
}

export function assertSnapshotWorkspace(cwd) {
	if (git(cwd, ["rev-parse", "--show-prefix"])) throw new Error("VPS–computer synchronization requires the Git repository root. Select the repository root or use Medium or Skip everything locally for a subdirectory.");
}

export function snapshot(cwd, ref) {
	if (!/^refs\/duo\/[a-z0-9/-]+$/.test(ref)) throw new Error("Invalid internal snapshot reference.");
	assertSnapshotWorkspace(cwd);
	const paths = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
	if (paths.some((name) => protectedPath(name) && !/(^|\/)\.env\.(?:example|sample|template)$/i.test(name))) {
		throw new Error("A credential-like file would be included in the remote snapshot. Exclude it with .gitignore before transferring this project.");
	}
	const temporary = createDuoTempDir("index-");
	const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index"),
		GIT_AUTHOR_NAME: "Duo", GIT_AUTHOR_EMAIL: "duo@localhost", GIT_COMMITTER_NAME: "Duo", GIT_COMMITTER_EMAIL: "duo@localhost" };
	try {
		git(cwd, ["read-tree", "HEAD"], { env });
		git(cwd, ["add", "-A", "--", "."], { env });
		const tree = git(cwd, ["write-tree"], { env });
		const existing = runCommand("git", ["rev-parse", "--verify", ref], { cwd, shell: false });
		const parent = existing.status === 0 ? existing.stdout.trim() : git(cwd, ["rev-parse", "HEAD"]);
		let revision = parent;
		if (git(cwd, ["rev-parse", `${parent}^{tree}`]) !== tree) {
			revision = git(cwd, ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent], { env, input: "Duo workspace snapshot\n" });
		}
		git(cwd, ["update-ref", ref, revision]);
		return { revision, tree, ref };
	} finally {
		for (const name of fs.readdirSync(temporary)) fs.unlinkSync(path.join(temporary, name));
		fs.rmdirSync(temporary);
	}
}

export function bundle(cwd, checkpoint) {
	assertSnapshotWorkspace(cwd);
	const directory = createDuoTempDir("bundle-");
	const file = path.join(directory, "snapshot.bundle");
	try {
		git(cwd, ["bundle", "create", file, checkpoint.ref]);
		if (fs.statSync(file).size > 24 * 1024 * 1024) throw new Error("Repository bundle exceeds 24 MB. Prepare a smaller task repository before remote execution.");
		return { ...checkpoint, data: fs.readFileSync(file).toString("base64") };
	} finally {
		if (fs.existsSync(file)) fs.unlinkSync(file);
		fs.rmdirSync(directory);
	}
}

export function receiveBundle(cwd, input, targetRef) {
	if (!input || !/^refs\/duo\/[a-z0-9/-]+$/.test(input.ref) || !/^refs\/duo\/[a-z0-9/-]+$/.test(targetRef) || !/^[a-f0-9]{40,64}$/.test(input.revision) || typeof input.data !== "string" || input.data.length > 34 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(input.data)) throw new Error("Invalid Git snapshot bundle.");
	const directory = createDuoTempDir("import-");
	const file = path.join(directory, "snapshot.bundle");
	try {
		fs.writeFileSync(file, Buffer.from(input.data, "base64"));
		git(cwd, ["bundle", "verify", file]);
		git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", file, `+${input.ref}:${targetRef}`]);
		if (git(cwd, ["rev-parse", targetRef]) !== input.revision) throw new Error("Imported snapshot does not match its revision.");
		return input.revision;
	} finally {
		if (fs.existsSync(file)) fs.unlinkSync(file);
		fs.rmdirSync(directory);
	}
}

export function applySnapshot(cwd, base, input, runId) {
	const target = receiveBundle(cwd, input, `refs/duo/${runId}/remote`);
	const current = snapshot(cwd, `refs/duo/${runId}/apply`);
	if (current.tree === input.tree) return;
	if (current.tree !== git(cwd, ["rev-parse", `${base}^{tree}`])) throw new Error("Local workspace changed during remote work. Remote results are preserved; reconcile them before applying.");
	const patch = runCommandChecked("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, target], { cwd, shell: false, maxBuffer: 48 * 1024 * 1024 }).stdout;
	if (!patch) return;
	git(cwd, ["apply", "--check", "--whitespace=nowarn", "-"], { input: patch });
	git(cwd, ["apply", "--whitespace=nowarn", "-"], { input: patch });
}

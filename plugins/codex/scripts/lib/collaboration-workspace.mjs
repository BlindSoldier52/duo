import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runCommand, runCommandChecked } from "./process.mjs";
import { fault } from "./collaboration-protocol.mjs";

function git(cwd, args, options = {}) {
	return runCommandChecked("git", args, { cwd, shell: false, maxBuffer: 32 * 1024 * 1024, ...options }).stdout;
}

const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".next", ".nuxt", ".cache", ".gradle", ".ssh", ".aws", ".azure", ".gnupg"]);

export function protectedPath(name) {
	return name.replace(/\\/g, "/").split("/").some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:.*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|(?:passwords?|secrets?)(?:\..*)?)$/i.test(part));
}

function excludedPath(name) {
	return protectedPath(name) || name.replace(/\\/g, "/").split("/").some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()));
}

export function isGitWorkspace(cwd) {
	if (!fs.statSync(cwd).isDirectory()) throw fault("The workspace path must be a directory.");
	const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
	if (result.error?.code === "ENOENT") return false;
	if (result.error) throw result.error;
	if (result.status === 0) return result.stdout.trim() === "true";
	if (/not a git repository/i.test(result.stderr)) return false;
	throw new Error(result.stderr.trim() || "Unable to detect the Git workspace.");
}

const BUILD_DIRECTORIES = new Set(["target", "dist", "build", "out", "obj"]);

function folderFiles(cwd, relative = "", files = []) {
	for (const entry of fs.readdirSync(path.join(cwd, relative), { withFileTypes: true })) {
		const name = relative ? `${relative}/${entry.name}` : entry.name;
		if (excludedPath(name)) continue;
		if (entry.isDirectory()) {
			if (!BUILD_DIRECTORIES.has(entry.name.toLowerCase())) folderFiles(cwd, name, files);
		} else files.push(name);
	}
	return files;
}

const digests = new Map();

function submoduleDigest(directory) {
	const head = git(directory, ["rev-parse", "HEAD"]).trim();
	const status = git(directory, ["status", "--porcelain", "--untracked-files=normal"]);
	const revision = fs.existsSync(path.join(directory, ".git")) ? workspaceRevision(directory) : "";
	return createHash("sha256").update(`submodule\0${head}\0${status}\0${revision}`).digest("hex");
}

function fileDigest(file, stat) {
	if (stat.isDirectory()) return submoduleDigest(file);
	const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.mode}`;
	const cached = digests.get(file);
	if (cached?.key === key) return cached.digest;
	const content = createHash("sha256");
	content.update(String(stat.mode & 0o777));
	if (stat.isSymbolicLink()) content.update(fs.readlinkSync(file));
	else if (stat.isFile()) {
		const descriptor = fs.openSync(file, "r");
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let length;
			while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) content.update(buffer.subarray(0, length));
		} finally { fs.closeSync(descriptor); }
	} else throw fault(`Unsupported workspace entry: ${path.basename(file)}`);
	const digest = content.digest("hex");
	digests.set(file, { key, digest });
	return digest;
}

export function workspaceSnapshot(cwd) {
	const kind = isGitWorkspace(cwd) ? "git" : "folder";
	const names = kind === "git" ? git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean) : folderFiles(cwd);
	const files = [...new Set(names)].filter((name) => !excludedPath(name)).sort();
	const hash = createHash("sha256");
	const entries = [];
	for (const name of files) {
		const file = path.join(cwd, name);
		let stat;
		try { stat = fs.lstatSync(file); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			hash.update(`${name}\0deleted\0`);
			continue;
		}
		const digest = fileDigest(file, stat);
		hash.update(`${name}\0${digest}\0`);
		entries.push([name, digest]);
	}
	return { kind, revision: hash.digest("hex"), files: Object.fromEntries(entries) };
}

export function workspaceRevision(cwd) {
	return workspaceSnapshot(cwd).revision;
}

export function workspaceDiff(cwd, baseline) {
	if (!isGitWorkspace(cwd)) {
		const current = workspaceSnapshot(cwd).files;
		const names = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(current)])].sort();
		const status = names.flatMap((name) => {
			if (!Object.hasOwn(current, name)) return [`D ${name}`];
			if (!baseline || !Object.hasOwn(baseline, name)) return [`${baseline ? "A" : "F"} ${name}`];
			return baseline[name] === current[name] ? [] : [`M ${name}`];
		}).join("\n");
		return { status, diff: "Folder workspace: changes are compared with this task's initial file fingerprints. Git history and unified diffs are unavailable. Dependency/cache directories and known credential paths are excluded." };
	}
	const head = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd });
	if (head.error) throw head.error;
	// Without a commit, compare the index with the empty tree and the worktree with the index.
	const bases = head.status === 0 ? [["HEAD"]] : [["--cached"], []];
	// Filtering is path-based: protected content pasted into a new ordinary file that Git does not
	// detect as a copy is still shown, subject only to redaction.
	const kept = new Set();
	for (const base of bases) {
		// --relative keeps paths relative to (and limited to) the workspace when it is a repository subdirectory.
		const tokens = git(cwd, ["--literal-pathspecs", "diff", ...base, "--relative", "--name-status", "-z", "-M", "-C"]).split("\0");
		for (let index = 0; index < tokens.length - 1;) {
			const code = tokens[index++];
			const paths = /^[RC]/.test(code) ? [tokens[index++], tokens[index++]] : [tokens[index++]];
			if (paths.some((name) => excludedPath(name))) continue;
			for (const name of paths) kept.add(name);
		}
	}
	let diff = "";
	for (const chunk of pathChunks([...kept].sort())) {
		for (const base of bases) diff += git(cwd, ["--literal-pathspecs", "diff", ...base, "--no-ext-diff", "--no-textconv", "--no-renames", "--", ...chunk]);
	}
	return { status: filteredStatus(cwd), diff };
}

function pathChunks(paths, limit = 8000) {
	const chunks = [];
	let chunk = [];
	let length = 0;
	for (const name of paths) {
		if (chunk.length && length + name.length + 3 > limit) { chunks.push(chunk); chunk = []; length = 0; }
		chunk.push(name);
		length += name.length + 3;
	}
	if (chunk.length) chunks.push(chunk);
	return chunks;
}

function filteredStatus(cwd) {
	const tokens = git(cwd, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]).split("\0");
	const lines = [];
	let hidden = 0;
	for (let index = 0; index < tokens.length - 1;) {
		const entry = tokens[index++];
		const code = entry.slice(0, 2);
		const target = entry.slice(3);
		const source = /[RC]/.test(code) ? tokens[index++] : null;
		if (excludedPath(target) || (source !== null && excludedPath(source))) { hidden++; continue; }
		lines.push(source === null ? `${code} ${target}` : `${code} ${source} -> ${target}`);
	}
	if (hidden) lines.push(`${hidden} protected ${hidden === 1 ? "entry" : "entries"} hidden`);
	return lines.length ? `${lines.join("\n")}\n` : "";
}

function outside(relative) {
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function projectFile(cwd, name) {
	if (typeof name !== "string" || !name || name.includes("\0")) throw fault("Invalid file path.");
	const candidate = path.resolve(cwd, name);
	const relative = path.relative(cwd, candidate);
	if (outside(relative) || relative.split(path.sep).includes(".git")) throw fault("File is outside the configured project.", 403);
	if (protectedPath(name)) throw fault("Credential files cannot be opened through the web interface.", 403);
	const real = fs.realpathSync(candidate);
	const resolved = path.relative(fs.realpathSync(cwd), real);
	if (outside(resolved)) throw fault("Symlinks outside the project are not accessible.", 403);
	if (protectedPath(resolved) || excludedPath(resolved)) throw fault("Protected files cannot be opened through the web interface.", 403);
	if (!fs.statSync(real).isFile() || fs.statSync(real).size > 1024 * 1024) throw fault("Only files up to 1 MB can be previewed.");
	return fs.readFileSync(real, "utf8");
}

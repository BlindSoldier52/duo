import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveStateDir } from "./state.mjs";

export function resolveDuoHome(env = process.env, platform = process.platform) {
	const directory = env.DUO_HOME || (platform === "win32"
		? path.join(env.APPDATA || env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Roaming"), "duo")
		: path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "duo"));
	if (!path.isAbsolute(directory)) throw new Error("The Duo data directory must be an absolute path.");
	return directory;
}

export function resolveDuoStateDir(cwd) {
	return path.join(resolveDuoHome(), "state", path.basename(resolveStateDir(cwd)));
}

export function createDuoTempDir(prefix) {
	const directory = path.join(resolveDuoHome(), "cache");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	return fs.mkdtempSync(path.join(directory, prefix));
}

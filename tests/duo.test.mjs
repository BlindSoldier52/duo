import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../duo.mjs", import.meta.url));
const oldBranding = /codex-plugin-cc|Crazytieguy|codex-companion|Codex Plugin|\/codex:setup|plugin marketplace|plugin install/i;

test("the public Duo entry point exposes branded help without starting providers or the server", () => {
	for (const args of [["help"], ["--help"], ["web", "--help"], ["collaborate", "--help"]]) {
		const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Duo — Codex × Claude collaboration/);
		assert.match(result.stdout, /--language/);
		assert.doesNotMatch(result.stdout, oldBranding);
	}
});

test("the public Duo entry point rejects unsupported commands with an actionable error", () => {
	const result = spawnSync(process.execPath, [entry, "unknown-fixture-command"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Unknown Duo command.*node duo\.mjs help/);
	assert.doesNotMatch(result.stderr, oldBranding);
});

test("Duo user documentation, package metadata, and dashboard do not advertise the old product", () => {
	for (const file of ["README.md", "guide.md", "plan.md", "docs/collaboration.md", "docs/safety.md", "docs/verification.md", "package.json", "package-lock.json", "plugins/codex/web/index.html"]) {
		assert.doesNotMatch(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), oldBranding, file);
	}
	const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.name, "duo");
	assert.equal(manifest.bin.duo, "duo.mjs");
	assert.equal(manifest.scripts.web, "node duo.mjs web");
	assert.match(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8"), /\[guide\.md\]\(guide\.md\)/);
});

function sshHosts(text) {
	const hosts = [];
	for (const [, block] of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
		for (const line of block.split("\n")) {
			const [command, ...args] = line.trim().split(/\s+/);
			if (command === "ssh") {
				for (let index = 0; index < args.length; index++) {
					if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[index])) index++;
					else if (!args[index].startsWith("-")) { hosts.push(args[index]); break; }
				}
			} else if (command === "scp") {
				for (const arg of args) {
					const remote = /^([^/\\:\s-][^/\\:\s]*):/.exec(arg);
					if (remote) hosts.push(remote[1]);
				}
			}
		}
	}
	return hosts.map((host) => host.replace(/^.*@/, ""));
}

test("distributed documentation uses placeholders instead of real hosts, addresses, or account paths", () => {
	const docs = ["README.md", "guide.md", "plan.md", "AGENT_RULES.template.md", "CONTRIBUTING.md", "SECURITY.md", ...fs.readdirSync(new URL("../docs", import.meta.url)).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
	for (const file of docs) {
		const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const [, user] of text.matchAll(/\/home\/([^/\s`'"]+)\//g)) assert.ok(["<user>", "user"].includes(user), `${file}: /home/${user}/ should use /home/<user>/`);
		for (const [address] of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) assert.equal(address, "127.0.0.1", `${file}: unexpected IPv4 address`);
		for (const host of sshHosts(text)) assert.equal(host, "my-vps", `${file}: SSH examples should use the my-vps alias`);
	}
});

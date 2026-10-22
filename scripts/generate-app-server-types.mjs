import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execute } from "../plugins/codex/scripts/lib/collaboration-process.mjs";

const output = fileURLToPath(new URL("../plugins/codex/.generated/app-server-types/", import.meta.url));
fs.mkdirSync(output, { recursive: true });
const result = await execute("codex", ["app-server", "generate-ts", "--out", output], { timeoutMs: 60000 });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || "App-server type generation failed.");
if (result.stdout) process.stdout.write(result.stdout);

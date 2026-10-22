import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateResponse } from "./collaboration-protocol.mjs";
import { writeJsonFile } from "./fs.mjs";
import { describeCommand } from "./claude.mjs";

const RETRY_LIMIT = 3;

export function extractResponse(text) {
	const source = String(text ?? "").trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)?.[1];
	const start = source.indexOf("{");
	const end = source.lastIndexOf("}");
	const candidates = [source, fenced, start !== -1 && end > start ? source.slice(start, end + 1) : null].filter(Boolean);
	let failure = new Error("The final message did not contain a JSON object.");
	for (const candidate of candidates) {
		try { return validateResponse(JSON.parse(candidate)); }
		catch (error) { failure = error; }
	}
	throw failure;
}

function attempts(file) {
	try { return Number(fs.readFileSync(`${file}.attempts`, "utf8")) || 0; }
	catch { return 0; }
}

export function handleStop(event, file) {
	try {
		writeJsonFile(file, { response: extractResponse(event.last_assistant_message), session: event.session_id });
		return null;
	} catch (error) {
		const count = attempts(file) + 1;
		fs.writeFileSync(`${file}.attempts`, String(count));
		if (count > RETRY_LIMIT) {
			writeJsonFile(file, { error: `Claude did not return a valid Duo response after ${RETRY_LIMIT} corrections: ${error.message}`, session: event.session_id });
			return null;
		}
		return { decision: "block", reason: `Duo could not read your answer: ${error.message} End your turn with a final message that contains only the JSON object described in the turn instructions, with no other text.` };
	}
}

export function handleActivity(event, file) {
	const input = event.tool_input ?? {};
	if (typeof input.command === "string") {
		fs.appendFileSync(file, `${JSON.stringify({ message: describeCommand(input.command) })}\n`);
		return;
	}
	const target = input.file_path ?? input.path ?? input.pattern ?? "";
	if (typeof target === "string" && target.endsWith(".prompt.md")) {
		fs.appendFileSync(file, `${JSON.stringify({ message: "Reading Duo's instructions" })}\n`);
		return;
	}
	const shown = typeof target === "string" && event.cwd && path.isAbsolute(target) ? path.relative(event.cwd, target) || "." : target;
	fs.appendFileSync(file, `${JSON.stringify({ message: shown ? `${event.tool_name} ${shown}` : event.tool_name })}\n`);
}

async function main() {
	const [mode, file] = process.argv.slice(2);
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	const event = JSON.parse(input);
	if (mode === "activity") return handleActivity(event, file);
	const decision = handleStop(event, file);
	if (decision) process.stdout.write(JSON.stringify(decision));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

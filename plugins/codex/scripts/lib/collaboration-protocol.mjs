import { createHash } from "node:crypto";

export const AGENTS = ["codex", "claude"];
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateLanguage(value) {
	if (value == null) return "English";
	if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw fault("Enter a language name or code of up to 80 characters.");
	const language = value.trim() || "English";
	if (!/^[\p{L}][\p{L}\p{M}\p{N} ()'.,-]{0,79}$/u.test(language)) throw fault("Enter a language name or code of up to 80 characters.");
	return language;
}

export function validateModel(value) {
	if (value == null || value === "") return null;
	if (typeof value !== "string" || !MODEL_NAME.test(value)) throw fault("Use a model identifier or alias, not a URL, path, or command.");
	return value;
}

export const RESPONSE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["message", "plan", "verdict", "blockingIssues", "notes", "routing"],
	properties: {
		message: { type: "string", minLength: 1, maxLength: 64000 },
		plan: { type: "string", maxLength: 200000 },
		verdict: { type: "string", enum: ["approve", "revise", "blocked"] },
		blockingIssues: { type: "array", maxItems: 100, items: { type: "string", maxLength: 4096 } },
		notes: { type: "string", maxLength: 4000 },
		routing: { anyOf: [
			{ type: "null" },
			{ type: "object", additionalProperties: false, required: ["model", "repeat", "reason"], properties: {
				model: { anyOf: [{ type: "null" }, { type: "string", pattern: MODEL_NAME.source, maxLength: 128 }] },
				repeat: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 2000 }
			} }
		] }
	}
};

export function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function validateResponse(value) {
	if (!value || typeof value.message !== "string" || typeof value.plan !== "string" ||
		!value.message.trim() || value.message.length > 64000 || value.plan.length > 200000 ||
		!["approve", "revise", "blocked"].includes(value.verdict) ||
		!Array.isArray(value.blockingIssues) || value.blockingIssues.length > 100 || value.blockingIssues.some((item) => typeof item !== "string" || item.length > 4096)) {
		throw new Error("Agent returned an invalid collaboration response.");
	}
	if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length > 4000)) {
		throw new Error("Agent returned invalid project notes.");
	}
	if (value.verdict === "approve" && value.blockingIssues.length) {
		throw new Error("Agent approved a result while reporting blocking issues.");
	}
	if (value.routing != null) {
		const route = value.routing;
		if (typeof route !== "object" || Array.isArray(route) || !Object.hasOwn(route, "model") ||
			(route.model !== null && (typeof route.model !== "string" || !MODEL_NAME.test(route.model))) ||
			typeof route.repeat !== "boolean" || typeof route.reason !== "string" || !route.reason.trim() || route.reason.length > 2000 ||
			Object.keys(route).some((key) => !["model", "repeat", "reason"].includes(key))) {
			throw new Error("Agent returned an invalid model-routing request.");
		}
	}
	return value;
}

export function redact(value) {
	return String(value)
		.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
		.replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function fault(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

export function parseCliJson(text) {
	return JSON.parse(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
}

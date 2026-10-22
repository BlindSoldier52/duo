const $ = (id) => document.getElementById(id);
const AGENTS = ["codex", "claude"];
const NAMES = { codex: "Codex", claude: "Claude", user: "You" };
const PHASES = { queued: "Queued", discussing: "Discussion", awaiting_user: "Waiting for your decision", implementing: "Implementation", reviewing: "Independent review", verifying: "Verification", needs_attention: "Needs attention", waiting_quota: "Usage limit", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled", cancelling: "Cancelling" };
const STAGES = { proposal: "proposals", draft: "drafting the plan", "plan-review": "plan review", implement: "implementation", verify: "checks", review: "final review", chat: "answering you" };
const MODES = { medium: "Medium", "skip-everything": "Skip everything", split: "VPS–computer" };
const ACTIVITY_TYPES = new Set(["activity", "operation", "error", "state", "action", "check", "model-selection", "model-request-ignored", "halted"]);

const state = {
	csrf: null,
	current: null,
	stream: null,
	planDirty: false,
	modeDirty: false,
	editorRevision: null,
	shownMessages: 0,
	working: new Set(),
	refreshTimer: null,
	refreshing: null,
	announcements: [],
	announceTimer: null
};

const reloadPlan = document.createElement("button");
reloadPlan.type = "button";
reloadPlan.textContent = "Reload plan";
reloadPlan.className = "quiet";
document.querySelector(".plan-actions").append(reloadPlan);
const formError = document.createElement("p");
formError.className = "form-error";
formError.setAttribute("role", "alert");
formError.hidden = true;
$("create-submit").before(formError);

function notice(message) {
	$("notice").textContent = message ?? "";
}

function announce(message) {
	state.announcements.push(message);
	clearTimeout(state.announceTimer);
	state.announceTimer = setTimeout(() => {
		$("announcer").textContent = "";
		const text = state.announcements.join(" ");
		state.announcements = [];
		setTimeout(() => { $("announcer").textContent = text; }, 50);
	}, 400);
}

async function api(url, data) {
	const response = await fetch(url, {
		method: data ? "POST" : "GET",
		headers: data ? { "Content-Type": "application/json", "X-CSRF-Token": state.csrf ?? "" } : {},
		...(data ? { body: JSON.stringify(data) } : {})
	});
	let value;
	try { value = await response.json(); }
	catch { throw Object.assign(new Error(`The server returned an unreadable response (HTTP ${response.status}).`), { status: response.status }); }
	if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status });
	return value;
}

function guarded(callback) {
	return async (event) => {
		event?.preventDefault();
		try { await callback(event); }
		catch (error) {
			notice(error.message);
			if ($("create-dialog").open) { formError.textContent = error.message; formError.hidden = false; }
		}
	};
}

function operations(run) {
	return run.operations ?? [];
}

function isIdle(run) {
	return !operations(run).length && (run.paused || !["discussing", "implementing", "reviewing", "verifying", "cancelling"].includes(run.phase));
}

function phaseLabel(run) {
	return run.paused ? "Paused" : PHASES[run.phase] ?? run.phase;
}

async function loadRuns() {
	const runs = await api("/api/runs");
	const list = $("runs");
	const focused = document.activeElement?.closest?.(".run-item")?.dataset.id;
	const buttons = runs.map((run) => {
		const button = document.createElement("button");
		button.className = `run-item${state.current?.id === run.id ? " active" : ""}`;
		button.dataset.id = run.id;
		button.setAttribute("aria-current", state.current?.id === run.id ? "page" : "false");
		const title = document.createElement("strong");
		title.textContent = run.task;
		const status = document.createElement("span");
		status.textContent = phaseLabel(run);
		button.append(title, status);
		button.addEventListener("click", guarded(() => selectRun(run.id)));
		return button;
	});
	if (buttons.length) list.replaceChildren(...buttons);
	else list.textContent = "Your conversations will appear here.";
	if (focused) list.querySelector(`[data-id="${focused}"]`)?.focus();
}

function messageCard(message) {
	const article = document.createElement("article");
	article.className = "message-card";
	article.dataset.sender = message.sender;
	const heading = document.createElement("div");
	heading.className = "message-heading";
	const avatar = document.createElement("span");
	avatar.className = `avatar ${message.sender}`;
	avatar.textContent = message.sender === "claude" ? "✳" : message.sender === "codex" ? "C" : "You";
	avatar.setAttribute("aria-hidden", "true");
	const author = document.createElement("strong");
	author.textContent = NAMES[message.sender] ?? message.sender;
	const details = document.createElement("small");
	const recipient = message.recipient === "both" ? "both" : message.recipient === "user" ? "you" : NAMES[message.recipient] ?? message.recipient;
	details.textContent = `to ${recipient} · ${message.host ?? "local"}`;
	if (message.sender === "user" && message.change) details.textContent += " · changes the task";
	if (message.sender !== "user") {
		details.textContent += ` · ${message.model ?? (message.requestedModel ? `requested ${message.requestedModel}` : "model not reported")}`;
		if (message.verdict && message.phase !== "chat") details.textContent += ` · verdict: ${message.verdict}`;
		if (message.provisional) details.textContent += " · intermediate pass";
	}
	const time = document.createElement("time");
	time.dateTime = message.at;
	time.textContent = new Date(message.at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
	const content = document.createElement("div");
	content.className = "message-content";
	content.textContent = message.content;
	if (message.blockingIssues?.length) content.textContent += `\n\nBlocking issues:\n${message.blockingIssues.map((issue) => `- ${issue}`).join("\n")}`;
	heading.append(avatar, author, details, time);
	article.append(heading, content);
	return article;
}

function renderMessages(run) {
	const box = $("messages");
	if (state.shownMessages === run.messages.length) return;
	const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
	const rebuild = state.shownMessages <= 0 || state.shownMessages > run.messages.length;
	if (rebuild) {
		box.setAttribute("aria-busy", "true");
		box.replaceChildren(...run.messages.map(messageCard));
		box.removeAttribute("aria-busy");
	} else box.append(...run.messages.slice(state.shownMessages).map(messageCard));
	state.shownMessages = run.messages.length;
	if (atBottom || rebuild) box.scrollTop = box.scrollHeight;
}

function renderPlan(run) {
	if (!state.planDirty) { $("plan").value = run.plan; state.editorRevision = run.planRevision; }
	const idle = isIdle(run);
	const ended = ["completed", "rejected", "cancelled"].includes(run.phase);
	const stale = state.planDirty && state.editorRevision !== run.planRevision;
	$("plan").disabled = !run.plan || operations(run).length > 0;
	$("plan-hint").textContent = stale
		? "A newer revision is available. Keep a copy of your edits and reload the plan before applying them."
		: run.planRevision ? `Revision ${run.planRevision.slice(0, 10)}${state.planDirty ? " · unsaved changes" : ""}` : "The agents will build a shared plan here.";
	$("votes").textContent = AGENTS.map((agent) => `${NAMES[agent]}: ${run.planVotes[agent]?.verdict ?? "waiting for review"}`).join(" · ");
	$("approve").disabled = run.phase !== "awaiting_user" || state.planDirty || !idle;
	$("revise").disabled = !run.plan || !idle || ended || stale;
}

function renderControls(run) {
	const idle = isIdle(run);
	const ended = ["completed", "rejected", "cancelled"].includes(run.phase);
	$("reject").disabled = !idle || !["awaiting_user", "needs_attention"].includes(run.phase);
	$("pause").disabled = ended || run.paused || run.phase === "cancelling";
	$("resume").disabled = ended || run.phase === "cancelling" || (!run.paused && !["needs_attention", "waiting_quota"].includes(run.phase));
	$("cancel").disabled = ended || run.phase === "cancelling";
	const closed = ["rejected", "cancelled", "cancelling"].includes(run.phase);
	$("message").disabled = closed;
	$("change").disabled = closed;
	$("send").disabled = closed;
	const active = operations(run).map((operation) => `${NAMES[operation.agent]}: ${STAGES[operation.phase] ?? operation.phase}`);
	$("operation").textContent = active.length
		? `${active.join(" · ")}${run.paused ? " · pause takes effect after the current step" : ""}`
		: run.paused ? "New steps are paused." : "No operation in progress.";
	if (!state.modeDirty && document.activeElement !== $("run-mode")) $("run-mode").value = run.mode;
	$("run-mode").disabled = !idle || ended;
	$("change-mode").disabled = !idle || ended;
	if (document.activeElement !== $("run-language")) $("run-language").value = run.language ?? "English";
	$("run-language").disabled = !idle || ["rejected", "cancelled"].includes(run.phase);
	$("apply-language").disabled = $("run-language").disabled;
}

function latestActivity(run, agent) {
	for (let index = run.events.length - 1; index >= 0; index--) {
		const event = run.events[index];
		if (event.agent !== agent) continue;
		if (event.type === "activity") return event.message;
		if (event.type === "operation") return null;
	}
	return null;
}

function renderAgents(run) {
	const busy = new Map(operations(run).map((operation) => [operation.agent, operation]));
	for (const agent of AGENTS) {
		const operation = busy.get(agent);
		const requested = operation?.model ?? run.activeModels?.[agent] ?? run[`${agent}Model`];
		const reported = run.models[agent];
		$(`${agent}-model`).textContent = `${reported ? `Reported: ${reported}` : "Model not reported"} · requested: ${requested ?? "CLI default"} · ${run.mode === "split" && run.remoteAgent === agent ? "VPS" : "computer"}`;
		const activity = operation && latestActivity(run, agent);
		$(`${agent}-state`).textContent = operation ? `Working${activity ? `: ${activity}` : "…"}` : run.sessions[agent] ? "Session retained" : "Not started";
		$(`${agent}-state`).title = $(`${agent}-state`).textContent;
	}
	const now = new Set(busy.keys());
	const started = [...now].filter((agent) => !state.working.has(agent)).map((agent) => `${NAMES[agent]} is working on ${STAGES[busy.get(agent).phase] ?? busy.get(agent).phase}.`);
	const finished = [...state.working].filter((agent) => !now.has(agent)).map((agent) => `${NAMES[agent]} finished.`);
	if (started.length || finished.length) announce([...finished, ...started].join(" "));
	state.working = now;
}

function renderChecks(run) {
	const open = new Set([...$("checks").querySelectorAll("details[open]")].map((item) => item.dataset.key));
	const items = run.checks.map((check, index) => {
		const item = document.createElement("details");
		item.className = "check";
		item.dataset.status = check.status;
		item.dataset.key = `${index}:${check.args.join(" ")}`;
		item.open = open.has(item.dataset.key);
		const title = document.createElement("summary");
		title.textContent = `${check.status === "passed" ? "Passed" : "Failed"}: ${check.args.join(" ")} · ${check.host}`;
		const output = document.createElement("pre");
		output.textContent = check.output;
		item.append(title, output);
		return item;
	});
	if (!items.length) {
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = run.commands.length ? "Checks have not run yet." : "No verification commands configured; reviewers will inspect the artifacts.";
		items.push(empty);
	}
	$("checks").replaceChildren(...items);
	$("final-votes").textContent = AGENTS.map((agent) => `${NAMES[agent]}: ${run.votes[agent]?.verdict ?? "no final verdict"}`).join(" · ");
}

function renderActivity(run) {
	$("activity").textContent = run.events.filter((event) => ACTIVITY_TYPES.has(event.type)).slice(-40)
		.map((event) => `${new Date(event.at).toLocaleTimeString("en")} ${event.agent ? NAMES[event.agent] : ""} ${event.model ? `${event.model} · ` : ""}${event.message ?? event.phase ?? event.action ?? event.type}`)
		.join("\n") || "Waiting.";
}

function render(run) {
	$("run-title").textContent = run.task;
	$("run-title").title = run.task;
	$("phase").textContent = phaseLabel(run);
	$("mode-label").textContent = `${MODES[run.mode]} · Round ${run.round}/${run.maxRounds}`;
	renderMessages(run);
	renderPlan(run);
	renderControls(run);
	renderAgents(run);
	renderChecks(run);
	renderActivity(run);
	if (run.error) notice(run.error);
}

async function refresh() {
	if (!state.current) return;
	if (state.refreshing) { await state.refreshing; return refresh(); }
	const id = state.current.id;
	state.refreshing = (async () => {
		const run = await api(`/api/runs/${id}`);
		if (state.current?.id === id) { state.current = run; render(run); }
		await loadRuns();
	})();
	try { await state.refreshing; }
	finally { state.refreshing = null; }
}

function scheduleRefresh() {
	clearTimeout(state.refreshTimer);
	state.refreshTimer = setTimeout(() => refresh().catch((error) => notice(error.message)), 150);
}

async function checkSession() {
	try { await api("/api/runs"); }
	catch (error) {
		if (error.status !== 401) return;
		state.stream?.close();
		$("connection-label").textContent = "Sign-in required";
		notice("This browser is no longer signed in. Press Enter in the Duo terminal to print a new sign-in link, then open it.");
	}
}

function connect(id) {
	state.stream?.close();
	state.stream = new EventSource(`/api/runs/${id}/events?after=${state.current.eventCounter ?? state.current.events.at(-1)?.id ?? 0}`);
	state.stream.onmessage = scheduleRefresh;
	state.stream.onopen = () => { $("connection-label").textContent = "Live connection"; $("connection-dot").classList.add("online"); };
	state.stream.onerror = () => {
		$("connection-label").textContent = "Reconnecting…";
		$("connection-dot").classList.remove("online");
		checkSession();
	};
}

async function selectRun(id) {
	if (state.planDirty && !confirm("The plan has unsaved changes. Switch conversations?")) return;
	state.planDirty = false;
	state.modeDirty = false;
	state.shownMessages = -1;
	state.working = new Set();
	notice(null);
	state.current = await api(`/api/runs/${id}`);
	render(state.current);
	await loadRuns();
	connect(id);
	const url = new URL(location.href);
	url.searchParams.set("run", id);
	history.replaceState(null, "", url);
}

async function action(name, data = {}) {
	if (!state.current) return;
	state.current = await api(`/api/runs/${state.current.id}/actions`, { action: name, requestId: crypto.randomUUID(), ...data });
	notice(null);
	await refresh();
}

function splitCommand(line) {
	const tokens = [];
	let token = "";
	let quote = null;
	let started = false;
	for (const character of line) {
		if (quote) { if (character === quote) quote = null; else token += character; started = true; }
		else if (character === '"' || character === "'") { quote = character; started = true; }
		else if (/\s/.test(character)) { if (started) { tokens.push(token); token = ""; started = false; } }
		else { token += character; started = true; }
	}
	if (quote) throw new Error("Close the quotation marks in the verification command.");
	if (started) tokens.push(token);
	return tokens;
}

function commandLines(id) {
	return $(id).value.split("\n").map((line) => line.trim()).filter(Boolean).map(splitCommand);
}

async function sendMessage() {
	$("send").disabled = true;
	try {
		await action("message", { content: $("message").value, recipient: $("recipient").value, change: $("change").checked });
		$("message").value = "";
		$("change").checked = false;
		announce("Message sent.");
	} finally { $("send").disabled = false; }
}

async function createRun() {
	$("create-submit").disabled = true;
	try {
		const split = $("mode").value === "split";
		const run = await api("/api/runs", {
			requestId: crypto.randomUUID(), task: $("task").value, criteria: $("criteria").value || $("task").value,
			language: $("language-input").value, mode: $("mode").value, implementer: $("implementer").value, policy: $("policy").value,
			codexModel: $("codex-input").value, claudeModel: $("claude-input").value, modelPolicy: $("model-policy").value, effort: $("effort").value, windows: $("windows").checked,
			maxPasses: Number($("max-passes").value), maxRounds: Number($("max-rounds").value),
			commands: commandLines("commands"), remoteCommands: commandLines("remote-commands"), remoteAgent: $("remote-agent").value,
			remote: split ? { alias: $("remote-alias").value, cwd: $("remote-cwd").value, worker: $("remote-worker").value } : null
		});
		$("create-dialog").close();
		notice(null);
		await selectRun(run.id);
		announce("Conversation created. The agents are starting.");
		$("conversation").focus();
	} finally { $("create-submit").disabled = false; }
}

function selectTab(button) {
	for (const tab of document.querySelectorAll("[data-tab]")) {
		const selected = tab === button;
		tab.setAttribute("aria-selected", String(selected));
		tab.tabIndex = selected ? 0 : -1;
		$(`${tab.dataset.tab}-panel`).hidden = !selected;
	}
}

function bindTabs() {
	const tabs = [...document.querySelectorAll("[data-tab]")];
	for (const button of tabs) {
		button.addEventListener("click", () => {
			selectTab(button);
			if (button.dataset.tab === "changes") $("refresh-diff").click();
		});
		button.addEventListener("keydown", (event) => {
			const index = tabs.indexOf(button);
			const targets = { ArrowRight: tabs[(index + 1) % tabs.length], ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length], Home: tabs[0], End: tabs.at(-1) };
			const target = targets[event.key];
			if (!target) return;
			event.preventDefault();
			selectTab(target);
			target.focus();
		});
	}
}

function bindControls() {
	for (const name of ["pause", "resume", "cancel", "reject"]) $(name).addEventListener("click", guarded(() => action(name)));
	$("approve").addEventListener("click", guarded(() => action("approve", { planRevision: state.current.planRevision })));
	$("revise").addEventListener("click", guarded(async () => {
		await action("revise", { plan: $("plan").value, planRevision: state.editorRevision });
		state.planDirty = false;
		await refresh();
	}));
	reloadPlan.addEventListener("click", () => {
		if (!state.current || (state.planDirty && !confirm("Discard your unsaved plan changes?"))) return;
		state.planDirty = false;
		renderPlan(state.current);
	});
	$("plan").addEventListener("input", () => { state.planDirty = true; renderPlan(state.current); });
	$("message-form").addEventListener("submit", guarded(sendMessage));
	$("message").addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $("message-form").requestSubmit(); }
	});
	for (const id of ["new-run", "empty-start"]) $(id)?.addEventListener("click", () => { formError.hidden = true; $("create-dialog").showModal(); });
	$("close-dialog").addEventListener("click", () => $("create-dialog").close());
	$("mode").addEventListener("change", () => { $("remote-fields").hidden = $("mode").value !== "split"; });
	$("create-form").addEventListener("submit", guarded(createRun));
	$("refresh-diff").addEventListener("click", guarded(async () => {
		if (!state.current) return;
		const result = await api(`/api/runs/${state.current.id}/artifacts`);
		$("diff").textContent = `${result.status || "Clean working directory."}\n\n${result.diff || "No tracked Git changes. New files are listed in the status."}`;
	}));
	$("run-mode").addEventListener("change", () => { state.modeDirty = true; });
	$("change-mode").addEventListener("click", guarded(async () => {
		await action("mode", { mode: $("run-mode").value });
		state.modeDirty = false;
	}));
	$("apply-language").addEventListener("click", guarded(() => action("language", { language: $("run-language").value })));
	window.addEventListener("beforeunload", (event) => { if (state.planDirty) { event.preventDefault(); event.returnValue = ""; } });
	bindTabs();
}

async function signIn() {
	if (location.hash.length <= 1) return null;
	const token = location.hash.slice(1);
	history.replaceState(null, "", location.pathname + location.search);
	try { await api("/api/session", { token }); return null; }
	catch (error) { return error; }
}

async function showRuntime() {
	const status = await api("/api/runtime");
	if (state.current) return;
	for (const agent of AGENTS) $(`${agent}-state`).textContent = status[agent].available ? `${status[agent].version} · ${status[agent].auth}` : "CLI unavailable";
}

async function boot() {
	bindControls();
	const loginError = await signIn();
	let config;
	try { config = await api("/api/bootstrap"); }
	catch (error) { throw loginError ?? error; }
	state.csrf = config.csrf;
	$("workspace").textContent = `${config.cwd} · ${config.workspaceKind === "folder" ? "Folder (no Git)" : "Git workspace"}`;
	if (config.workspaceKind === "folder") {
		for (const select of [$("mode"), $("run-mode")]) {
			const option = select.querySelector('option[value="split"]');
			option.disabled = true;
			option.textContent = "VPS–computer (requires Git)";
		}
	}
	$("new-run").disabled = false;
	$("empty-start").disabled = false;
	$("connection-dot").classList.add("online");
	$("connection-label").textContent = "Connected locally";
	await loadRuns();
	const selected = new URL(location.href).searchParams.get("run");
	if (selected) await selectRun(selected);
	else if (config.runs.length) await selectRun(config.runs[0].id);
	showRuntime().catch(() => {});
}

boot().catch((error) => { notice(error.message); $("connection-label").textContent = "Sign-in required"; });

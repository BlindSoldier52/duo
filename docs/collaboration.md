# Duo: Codex × Claude collaboration

Duo provides a private web dashboard and a shared coordinator for Codex and Claude. You can talk to both agents, inspect their discussion, edit the plan, and control execution from one browser tab.

The dashboard controls, documentation, and default agent response language are English. The persisted `language` setting accepts a language name or code and applies to both agents. An authenticated user's latest explicit language request takes precedence; the language of a task or quoted text alone does not change the preference. Existing messages are preserved as written. For a step-by-step first run and VPS setup examples, start with [the user guide](../guide.md).

## Start locally

Install Node.js 22.4 or later, Codex CLI, and a recent Claude Code version supporting `--restricted`. Git is optional for local tasks and required for VPS synchronization. Sign in to Codex with your ChatGPT account and to Claude Code with your Claude account. The dashboard reads the CLI authentication status; it does not ask for provider passwords or copy credentials into frontend code.

Install once from this repository:

```sh
node duo.mjs install
```

For another project, with or without Git:

```sh
duo web --cwd /absolute/path/to/project --port 3210
```

The installer copies the application, shared policy, web assets, and documentation into `%APPDATA%\duo\app` on Windows, then registers `duo` with an offline local npm link. The installed package is self-contained and does not depend on the source checkout. Then `duo web` works from any project folder, or use `duo web /absolute/path/to/project`. Startup loads application files from the installed entry point, not from the workspace's `package.json`. Running `npm run web` elsewhere still invokes npm's own package discovery; use `duo` or the installed absolute Node entry point instead. `npm run web` in the source checkout remains a development entry point.

Install updates from the updated source with `node duo.mjs install`, after stopping coordinators. The installer and normal startup share an installation lock; live coordinators prevent replacement, app backups are retained, and state is not replaced. `DUO_HOME` overrides the entire data directory. Native provider stores are neither copied nor relocated. See [installation and state](../guide.md#installation-state-and-updates).

Git detection is automatic. In a plain folder, the coordinator recursively fingerprints file contents and modes, skips known credential paths, dependency/cache directories, and build output folders named `target`, `dist`, `build`, `out`, or `obj`, and does not follow symbolic-link targets. Files larger than 16 MB are fingerprinted by size and modification time instead of content, and unchanged files are not read again. Medium and Skip everything retain revision-bound approvals, verification, and independent final votes. The task's initial file fingerprints are persisted for added/modified/deleted status after restart. No repository or project manifest is created. Plain folders have no Git history, ignore-rule processing, or unified diff; excluded files are outside revision coverage. Changes inside the skipped build folders are not detected or listed. VPS synchronization remains Git-only, with an existing commit required.

Open the private sign-in link printed in the terminal. The server binds to `127.0.0.1`; the link's one-time fragment establishes an HttpOnly browser session that lasts up to 30 days while the server keeps running, and the fragment is removed from the address bar. If you need another link, for example for a second browser, press Enter in the terminal; the previous unused link stops working. Keep the terminal open. Stop it with Ctrl+C; interrupted operations are checkpointed and require inspection before resuming.

The server and frontend use the Node.js standard library and plain HTML/CSS/JavaScript. There is no frontend build or additional runtime dependency. The existing TypeScript build generates App Server protocol types through a portable Node script.

## Dashboard

Create a conversation with a task, observable acceptance criteria, and a mode. Choose an implementation owner, optional initial model identifiers, adaptive or fixed model selection, and verification commands. Each verification command is entered on its own line; quoted arguments are supported. Commands execute directly without a shell: pipelines, shell substitutions, and `&&` are not interpreted.

The common chat shows who sent each message, its intended recipient, and the host. You can address both agents or one participant; when both are addressed they answer in parallel. Messages received during an operation are processed at the next scheduling boundary. A message is a read-only question by default: it does not reopen planning or invalidate an approval. A message marked as a task change triggers a new draft and plan review and invalidates previous plan authorization.

Independent steps run in parallel: both proposals, both plan reviews, and both final reviews. The implementation owner drafts the shared plan. Each provider session receives the shared rules once as system or developer instructions, and later turns carry only a short header with new messages and any changed plan. Claude reports the tools it uses while it works, and Codex reuses one app-server process for the whole coordinator session.

With agent windows enabled, Codex runs behind a local app-server that listens only on `127.0.0.1` and requires a random capability token; Duo and a visible `codex resume --remote` window both connect to it, and the sandbox mode is set on each turn. Claude runs as interactive Claude Code with the shared rules as an appended system prompt. Duo writes each turn's instructions to a private file, and a Stop hook validates Claude's final JSON answer, asks Claude to correct it up to three times, and hands it to Duo. A tool hook reports Claude's tool use to the dashboard. VPS agents always run hidden.

Agents remember what they read in two ways. Within a conversation, each turn tells the agent which project files changed since its previous turn, so it can rely on files it already read. Across conversations, each agent may return short project notes, such as layout, key files, build commands, and confirmed problems. Duo keeps the latest notes from each agent in `notes.json` next to the workspace's conversation records and gives them to both agents at the start of the next conversation, together with the files changed since the notes were written. Delete `notes.json` to make the agents start from scratch.

Choose **Response language** when creating a task. For an idle existing conversation, use **Response language** and **Apply language** under execution controls. This records an authenticated user preference without starting agent calls, rerunning implementation, or invalidating approvals. Active or unresolved operations must finish or be reconciled first. Legacy records without the field default to English in newly generated prompts; checkpointed prompts retain their original content.

The plan panel supports editing, submitting revisions for another review, approving, and rejecting. Approval applies to the exact displayed plan hash. The changes panel shows current Git status and tracked changes for repositories, or task-relative file status for plain folders; the checks panel displays recorded commands, outputs, environments, and final agent votes.

Pause stops new steps after the current operation. Sending a chat message that is only `stop` (also `stop everything`, `opreste`, `opreste tot`, with or without diacritics and punctuation) interrupts the agents immediately and pauses the run; Resume continues it, and interrupted implementation work goes to verification. The stop message itself is not shown to the agents. Cancel requests interruption and waits for confirmation. A disconnected remote worker can remain unconfirmed; the dashboard reports that instead of pretending cancellation succeeded. Closing the browser tab does not stop a run.

Only one operation sequence uses a workspace at a time. Additional tasks queue until that workspace is available. Both agents may review, but only the selected owner writes during implementation. This avoids concurrent edits to the same checkout.

## Modes

### Medium

Both agents propose an approach, Codex synthesizes a candidate plan, and both independently review it. Once they approve the same plan revision, the run waits for you. Editing the plan invalidates the old votes and starts another review. Approval authorizes implementation, verification, and final review. Rejection ends the run without implementation.

### Skip everything

The same discussion and plan reviews happen without a human plan-approval gate. The selected owner implements, the coordinator runs your checks, and both agents review the exact workspace revision. Blocking findings or failed checks start another correction round. Completion requires both final approvals and passing required checks.

The round limit defaults to twelve and can be configured from 1 to 30 when creating a task. A limit, refusal, missing response, or invalid output is never treated as agreement. A task without configured commands relies on direct artifact review; the dashboard explicitly states that no automated checks were configured.

### Adaptive model selection

New runs default to `adaptive`: both participants may request their own next model through the same provider CLI, starting from the configured initial choice or CLI default. Claude is no longer pinned to Opus. Choose `fixed` to prohibit agent-requested model changes; existing saved runs without a selection policy retain fixed behavior.

Agents return `routing: null` when no change is needed, or an object with `model`, `repeat`, and `reason`. A model identifier or alias applies to that participant's next call. A null model keeps the current selection. With `repeat: true`, the coordinator repeats the same agent/phase, preserving its session, ownership, and permission level; the current verdict is provisional and does not count as approval. With `repeat: false`, normal scheduling advances using the final response.

There are at most 12 calls per extra-pass sequence by default, configurable from 1 to 30 with `maxPasses`; this is separate from the discussion/correction round limit. Ten smaller-model passes are possible, not mandatory. A pass limit enters `needs_attention`, and an unavailable model or failed call stops for inspection instead of triggering an infinite fallback loop. Account quotas still apply; the application does not calculate a monetary or allowance budget from these limits.

The dashboard displays reported and requested models separately, labels intermediate responses, and records model-selection reasons in technical activity. Persisted `modelHistory` identifies each call, phase, host, requested model, and reported model. Runtime acceptance, not identifier syntax, establishes whether a model is usable for that request. Model prices and per-call subscription allowance are not inferred, and several smaller calls are not guaranteed to be cheaper overall.

Model switching uses the runtime's per-turn/per-session model options, not new credentials, provider endpoints, or paid API access. See the official [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server) and [Claude model configuration](https://code.claude.com/docs/en/model-config). All file, terminal, network, and approval restrictions remain unchanged after a model change.

### VPS–computer

Choose one remote participant and explicitly select Medium or Skip everything autonomy. The other participant runs on your computer. The VPS must run Linux with Node.js, Git, the selected CLI, and the worker from this checkout.

1. Copy this checkout's `plugins/codex` runtime directory to the VPS, preserving the directory structure.
2. Prepare a Git checkout and authenticate the selected CLI on that VPS.
3. Configure an SSH alias that works non-interactively with a known host key. Verify that `node` is in its non-interactive PATH.
4. Enter the alias, absolute project path, and absolute `plugins/codex/scripts/remote-worker.mjs` path in the dashboard.

The coordinator transfers Git snapshots, including relevant uncommitted changes, into a dedicated remote worktree. Snapshots use a temporary index and internal `refs/duo/` references; the user's local index and branch are not committed or reset. Remote writes are checkpointed in the owned worktree and returned as a bundle and binary-safe patch. Concurrent local changes prevent automatic patch application rather than being overwritten.

Bundles currently have a 24 MB limit. Remote worktrees and internal snapshot refs are retained for recovery; they are not automatically deleted. Transfer is between your configured machines, not through a public Git remote.

Remote jobs run independently of the SSH polling connection. Job IDs make start requests idempotent, and status queries resume an existing operation rather than starting it again. A failed write may leave changes in its dedicated remote worktree; inspect the reported path before retrying. Cancellation verifies the Linux worker process identity before signaling it.

Remote verification commands can be configured separately from local checks. Results identify the host. Installing dependencies and preparing the remote test environment remains a setup step; the coordinator does not silently install packages or migrate production systems.

## Runtime boundaries

Codex uses persistent App Server threads. Collaboration calls use direct connections, so a broker disconnect cannot silently replay an implementation turn. Claude uses persistent `claude -p` sessions with an optional per-call model selection rather than a mandatory Opus pin. Its restricted file tools are read-only outside implementation; only the implementation owner receives Edit and Write tools. During implementation Claude also receives a shell (Bash, plus PowerShell on Windows) so it can build and test its work. Unlike Codex, this shell has no operating-system sandbox, so Claude is told not to use the network but is not technically blocked from it. Outside implementation Claude has no shell, and configured verification commands always run through the coordinator.

Process helpers and direct App Server startup use separate executable/argument arrays with `shell: false`. On Windows they resolve native executables or known npm-installed Node CLI entry points instead of implicitly invoking CMD or a shell from `SHELL`. Unsupported batch wrappers fail with an actionable error rather than silently selecting another installation. An intentionally selected shell executable can still interpret its own arguments; command selection and runtime restrictions remain important. See Node's [DEP0190 guidance](https://nodejs.org/api/deprecations.html#DEP0190).

The bundled shared rules are in `plugins/codex/prompts/collaboration-rules.md`. Project instructions still apply according to each runtime's rules. The design template in `AGENT_RULES.template.md` is documentation, not a substitute for runtime restrictions. The dashboard does not disable provider controls or globally enable permission bypass.

See [the safety policy and enforcement boundaries](safety.md) for the detailed privacy, evidence, terminal, and incident rules. Codex may use CMD/PowerShell when permitted by the task, phase, and runtime; Claude's tool permissions are separate. The policy is loaded when the agent-runner module starts, so restart the coordinator and synchronize any deployed worker copy after policy edits. The rules do not constitute an outbound firewall or guarantee zero leaks or factual errors.

Credentials remain in CLI stores. Explicit API/provider environment credentials are rejected by collaboration adapters to avoid unintended billing changes. Account limits and model access still apply. No automatic purchase, upgrade, or model fallback is performed.

The web API requires a local session and CSRF token for actions, checks Host and Origin, and uses a restrictive content security policy. Model output is rendered as text. File previews are confined to the configured repository, reject escaping symlinks and common credential filenames, and limit file size. Redaction is a best-effort extra safeguard, not a guarantee that arbitrary secrets in source files will be recognized.

Do not expose the listener publicly. Remote browser access should use an authenticated private tunnel and a compatible local session; public hosting is not part of this implementation.

## CLI and state

```sh
node duo.mjs collaborate start --mode medium "Describe the task"
node duo.mjs collaborate start --model-policy adaptive --max-passes 12 "Describe another task"
node duo.mjs collaborate start --language German "Describe a task"
node duo.mjs collaborate language RUN_ID --language English
node duo.mjs collaborate status
node duo.mjs collaborate transcript RUN_ID
node duo.mjs collaborate approve RUN_ID --revision PLAN_HASH
```

The dashboard exposes the complete configuration and controls. Standalone CLI runs share the same state format, and only one coordinator may own a workspace at once; stop the web server before starting a standalone coordinator.

A second coordinator fails immediately with `Duo is already running for this workspace` and exits unsuccessfully, without interrupting the first instance or taking its lock. This applies across web and standalone CLI commands even when another port is selected. A valid ownership lock left by an exited process is recovered automatically; an old lock held by a live process is not treated as abandoned merely because of its age.

Local collaboration state lives under `%APPDATA%\duo\state\<workspace-id>\collaborations` by default on Windows. Temporary Git transfer artifacts use `%APPDATA%\duo\cache`. Linux coordinators use `$XDG_DATA_HOME/duo` or `~/.local/share/duo`; `DUO_HOME` overrides the data directory. The separately deployed Linux worker retains its existing remote-job/worktree layout.

The first open of a workspace copies its old local collaboration JSON records without replacing newer state, and retains the original files. Legacy and new ownership locks are both held during operation, so a live older instance prevents migration or duplicate execution. It records messages, sessions, operation checkpoints, checks, and revision-bound votes. Corrupt JSON is reported, not silently replaced with an empty state. Active runs found after restart require an explicit resume. Failed or uncertain remote operations retain their IDs and worktrees for inspection.

## Verification

```sh
node --test tests/process.test.mjs tests/duo.test.mjs tests/collaboration-lock.test.mjs tests/collaboration-language.test.mjs tests/collaboration-models.test.mjs tests/collaboration-policy.test.mjs tests/collaboration.test.mjs tests/collaboration-remote.test.mjs tests/web.test.mjs
npm run build
```

The tests simulate agent responses while exercising real orchestration, HTTP authentication, process cancellation, Git snapshots, binary patches, worktree preparation, and background worker verification. They do not consume provider allowance.

The policy tests verify that the rules are delivered as system instructions, that turn prompts carry the header without repeating them, message attribution including verdicts and blocking issues, incremental context for resumed sessions, and independent proposal context. They do not establish that a model always follows the policy or that data-loss prevention is enforced.

Model-routing tests use synthetic responses to verify changes for both participants, ten-pass scheduling, limits, fixed-model restrictions, session continuity, paused work, failed selections, unchanged write ownership, and Claude CLI argument construction. They do not measure actual model prices or prove account access to every identifier.

An optional live test uses your signed-in accounts and consumes allowance. In PowerShell:

```powershell
$env:DUO_LIVE_TEST = '1'
node --test tests/collaboration-live.test.mjs
Remove-Item Env:DUO_LIVE_TEST
```

It runs a small Medium discussion in a temporary Git project using GPT-6 Luna and Claude Opus 5.5. It verifies session continuity and joint plan approval without modifying the project under development. Actual SSH connectivity and VPS permissions require testing against your configured host.

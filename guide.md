# Duo user guide

Duo is the local web interface for a shared Codex–Claude conversation. You describe a task, follow the agents' discussion, edit or approve their plan, and inspect changes and verification results. The interface, documentation, and default agent response language are English. Set **Response language** to another language name or code, or explicitly request a different language in your message. Existing messages are not retroactively translated.

Install a self-contained copy in your Duo data directory, then use `duo` from any project folder. On Windows, the default data directory is `%APPDATA%\duo`.

## 1. Requirements and sign-in

- Node.js 22.4 or later (agent windows use Node's built-in WebSocket client). Git is optional for local tasks and required for VPS synchronization.
- A project folder, with or without Git or `package.json`. Use a small nonsecret project for your first run.
- Codex CLI on the machine where Codex will run, signed in with your ChatGPT account.
- A recent Claude Code supporting `--restricted` on the machine where Claude will run, signed in with your Claude account. It needs `--restricted`, `--append-system-prompt-file`, and `--output-format stream-json`; the current version was tested with Claude Code 2.1.308.

For both agents on your computer, check the tools in your terminal:

```sh
node --version
git --version
codex --version
claude --version
```

Use `codex login` to sign in to Codex. Open `claude` and complete its interactive sign-in if needed, then exit back to your terminal. In VPS–computer mode, sign in to each CLI on its own execution host; Claude does not also need to be installed locally when it runs remotely.

Use the normal subscription logins, not API keys. Do not paste passwords, private keys, tokens, or authentication-file contents into chat. Explicit API/provider environment credentials can cause the adapters to reject startup rather than silently change billing. Account model access and usage limits still apply.

## 2. Start the dashboard

Install once from this repository's root directory:

```sh
node duo.mjs install
```

The installer copies only the application runtime, shared policy, interface, and documentation to `%APPDATA%\duo\app` and registers the `duo` command through npm's offline local-link mechanism. It does not copy projects, dependencies, SSH keys, provider authentication stores, or the entire checkout. The installed runtime has no package dependencies. Run `duo help` for terminal controls.

No PHP, frontend build, or additional runtime dependency installation is required. Keep this terminal open while using Duo.

Open the complete private sign-in URL printed in the terminal, including its fragment after `#`. The listener uses `http://127.0.0.1:3210`; opening that address alone in a new browser session does not authenticate you. The sign-in fragment is consumed once and removed from the browser address bar. Treat the link as a sensitive access credential, not something to publish.

To start for another project, pass its absolute path. For example, in PowerShell:

```powershell
duo web --cwd "C:\Projects\your-project" --port 3210
```

Replace that example path with your actual project. The selected project is the workspace the agents inspect and, when authorized, modify. Run only one coordinator per workspace. Ctrl+C stops the server; interrupted operations require inspection before resuming.

### Start from any folder

Install the local `duo` command once, from the Duo checkout:

```powershell
node duo.mjs install
```

Then switch to any project folder and start Duo there:

```powershell
Set-Location "C:\Projects\your-project"
duo web
```

Alternatively, use `duo web "C:\Projects\your-project"` or `duo web --cwd "C:\Projects\your-project"`. The command loads the copied application from `%APPDATA%\duo\app` and defaults the workspace to your current folder. A `package.json` in that folder, a parent folder, or another project is not required and is not used to start Duo. The original checkout is no longer required for ordinary use. If the command is not found, ensure npm's global executable directory is on PATH and reopen your terminal. If PowerShell blocks npm's generated script, use `duo.cmd web` on Windows.

You can bypass command registration with `node "$env:APPDATA\duo\app\duo.mjs" web --cwd "C:\Projects\your-project"` in PowerShell. This also works from any folder.

`npm run web` is still an npm project script: in the source checkout it starts the development copy; in the installed application folder it starts the installed copy. Duo cannot intercept an npm error that happens before Duo starts. Use `duo web` when working elsewhere.

### Installation, state, and updates

- `%APPDATA%\duo\app`: self-contained runtime, web assets, bundled rules, and `guide.md`.
- `%APPDATA%\duo\state`: per-workspace conversations, checkpoints, checks, and file fingerprints.
- `%APPDATA%\duo\cache`: temporary Git indexes and snapshot bundles, normally removed after each transfer operation.
- `%APPDATA%\duo\backups`: previous installed application copies retained during updates.

Your projects remain where you selected them. Native Node, npm command shims, Codex/Claude executables, and their authentication stores remain in their normal locations; the installer does not move or read authentication files. The Linux SSH worker is separately installed on the VPS and retains its own job/worktree layout.

To update, stop active Duo coordinators, then run `node duo.mjs install` from the updated source checkout. Installing over an active coordinator is rejected without stopping it. Updates replace the app, not conversation state, and preserve the previous app under `backups`. Running `duo install` recopies the currently installed version; it does not download an update. No GitHub, registry, or other download is performed by the installer.

When a workspace first opens after the storage change, old local collaboration records are copied into the new state directory without overwriting newer records. Original state files remain as recovery copies. A live older coordinator prevents migration and a second coordinator; do not delete its lock. Interrupted conversations still require inspection before resuming.

Advanced: set `DUO_HOME` to an absolute path to override the data directory consistently for installation and all future launches. On Linux, the coordinator defaults to `$XDG_DATA_HOME/duo` or `~/.local/share/duo`. Changing `DUO_HOME` does not automatically migrate state from another custom data directory.

### Folders without Git

Duo detects Git automatically. Medium and Skip everything also work without a repository, without an initial commit, and without Git installed. Duo does not run `git init`, create a project manifest, or install project dependencies automatically.

In a plain folder, file-content fingerprints bind approvals and final votes to the reviewed files. The Changes panel lists added, modified, and deleted files relative to that task's start, including after a coordinator restart. It does not provide Git history or unified text diffs. There is no Git-ignore processing in this mode: other than excluded dependency/cache directories and known credential paths, all files, including generated files and binary assets, participate in change detection. Large folders can therefore take longer to inspect.

Known credential paths (including `.env*`, `.npmrc`, private-key extensions, and credential directories) are excluded before reading. This filename filter cannot identify arbitrary secrets: the no-read policy and host isolation still apply. Excluded files are not covered by revision checks. Use a task-specific, nonsecret folder.

VPS–computer synchronization requires the Git repository root with an existing commit on both hosts. A plain folder, a repository without commits, or a Git subdirectory is rejected before local provider calls or snapshot creation. Medium and Skip everything remain available locally from subdirectories. Bundles include repository history, so selecting a subdirectory cannot limit their scope.

If Duo is already running for that workspace, a second web or standalone coordinator exits immediately with `Duo is already running for this workspace` and a nonzero exit status. It does not stop the original instance, take over its lock, or start on another port. Use the original instance or stop it first. Locks left by an exited process are recovered automatically; never delete the lock of a running coordinator.

## 3. Create your first task

1. Click **New conversation** or **Start a task**.
2. Enter **Your task** and observable requirements under **How do we know it is done?**
3. Leave **Response language** as **English**, or choose/type another language such as **Romanian**, **German**, or `pt-BR`.
4. Choose **Medium** for the first run and select an **Implementation owner**.
5. Expand **Models and checks**. Keep **Adaptive** to let each agent choose its own next model, or select **Fixed** to keep the initial choices. Blank initial-model fields use CLI defaults.
6. Enter only the verification commands appropriate to your project, one per line. For example, `npm test` and `npm run build` are useful only if that project defines those scripts and they are safe to run.
7. Click **Start conversation**, follow the discussion, and inspect the **Plan** panel.

Example task:

> Add a short setup section to README.md. Change no other project files. Do not install packages, publish anything, or access credentials.

Example acceptance criteria:

> README.md explains how to start the project. Existing content remains intact. Both agents inspect the final document and report any checks that were not run.

Without configured verification commands, agents review the artifacts directly; Duo does not pretend automated tests passed. Commands run as executable/argument arrays without an implicit shell. Pipes, `&&`, and shell substitutions are not interpreted. Configured scripts can still execute code and access networks, so review them before authorizing execution.

## 4. Choose a workflow

| Mode | What happens | Your approval |
| --- | --- | --- |
| **Medium** | Agents discuss, synthesize a plan, and both review it before implementation. | Click **Approve plan** for the exact reviewed revision. |
| **Skip everything** | Discussion, implementation, checks, and independent final reviews run automatically within the task's scope. | No routine plan approval; safety and authorization boundaries remain. |
| **VPS–computer** | One participant runs through the configured Linux SSH worker. | Choose **Medium** or **Skip everything** under **Autonomy**. |

In Medium, edit the plan and click **Save and review** to have both agents review the new revision. Then approve the reviewed revision, or click **Reject** to end without implementation. Editing invalidates earlier approval; a stale browser tab cannot approve a newer plan.

The **Changes** tab shows Git status and tracked diffs, or task-relative file status without Git. **Tests** shows recorded verification output and final votes. **Technical activity** shows operation progress and model-selection reasons. Completion requires both final approvals for the same revision and passing required checks.

## 5. Chat, pause, and model choices

- To change the saved response language, use **Response language** and **Apply language** under **Execution controls** while the conversation is idle. If an operation is active, pause and wait for it to finish first. The setting survives restart and affects future prompts for both agents without rerunning implementation or changing approvals. An explicit language request in a message takes precedence; merely writing a task in another language does not automatically change the default.
- Choose **Both agents**, **Codex only**, or **Claude only** in the message recipient field. When you ask both, they answer at the same time. Press Ctrl+Enter to send.
- A message is treated as a question by default: the agents answer it and the task continues where it was, so an approved or pending plan is kept. Tick **This changes the task** when the message should change the work; the agents then revise the plan and review it again, and an earlier approval no longer applies.
- **Pause** stops new steps after the current operation finishes. **Resume** continues paused work or retries a recorded operation after you inspect it. It does not repair an unavailable model, missing login, quota limit, or uncertain remote write automatically.
- Type **stop** in the chat to stop both agents immediately without ending the task. Only a message that is just the stop word counts; `stop everything`, `opreste` and `opreste tot` work too, while a sentence such as "stop using var" is sent to the agents as usual. The run is then paused, so press **Resume** when you want the agents to continue.
- **Cancel** requests interruption. A remote cancellation can remain unconfirmed; closing the browser tab does not cancel a task.
- Questions after completion are read-only. A message marked **This changes the task** after completion starts a new planning round for the same conversation.
- In adaptive mode, either agent may request its own next model or another pass of the current phase, through the same provider CLI and subscription. Additional passes do not grant more tools or permission to open secret files.
- **Show agent windows** under **Models and checks** is on by default on Windows. Codex then runs in one terminal window for the whole conversation, attached to a private, token-protected Codex server that Duo also controls. Claude runs as normal interactive Claude Code, not `claude -p`, in a window that reopens for each of its turns and stays open until the next one. You can watch both and step in if needed. Closing a Claude window before it answers stops that step; resume it from the dashboard. Turn the option off to run both agents hidden.
- The agents remember what they read. During a conversation, Duo tells them which files changed since their last turn. Between conversations in the same project, they keep short notes about the project, which Duo stores in `notes.json` with the conversation records under `%APPDATA%\duo\state`. Delete that file if the notes become misleading.
- **Reasoning effort** under **Models and checks** applies to both agents. Low gives the fastest answers, high the most thorough ones; CLI default keeps each CLI's own setting.
- **Round limit** and **Passes per agent and phase** both default to 12 and accept values from 1 to 30. Ten smaller-model passes are possible, not mandatory or guaranteed to consume less allowance. Intermediate verdicts do not count as final approval.
- The agent cards distinguish requested models from runtime-reported models. If a model is unavailable or a limit is reached, inspect the error and transcript; do not interpret the stop as success.

## 6. Codex on your computer, Claude on a Linux VPS

Keep the coordinator on your computer for this layout. The VPS needs Linux, Node.js, Git, the matching worker files, and Claude Code authenticated for the remote account. SSH must work non-interactively with a verified host key. Do not copy CLI authentication stores or private SSH keys between machines.

Read-only checks from your computer:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes my-vps 'node --version; git --version; command -v claude'
```

Here `my-vps` is an example alias from your SSH configuration. Claude Code's installer commonly places the executable in `/home/<user>/.local/bin`. If `command -v claude` returns nothing, the noninteractive SSH `PATH` is probably missing that directory; this does not mean Claude is uninstalled. Configure the remote account's appropriate shell startup environment to include `/home/<user>/.local/bin` for noninteractive SSH, then repeat the check. The worker's child processes must inherit that path. Do not disable host verification or run the worker as root to bypass setup problems.

Install the same version of this checkout's `plugins/codex` directory on the VPS, preserving its structure. For example, after reviewing the runtime files to be transferred:

```sh
ssh my-vps 'mkdir -p /home/<user>/tools/duo/plugins'
scp -r plugins/codex my-vps:/home/<user>/tools/duo/plugins/
```

Those commands are manual setup examples, not a claim that deployment has already been completed. Choose an actual Git repository root on the VPS; do not use a production checkout or a directory containing credentials. The local workspace must also be a repository root. In **New conversation**, select **VPS–computer** and fill in:

| Field | Value |
| --- | --- |
| Remote agent | **Claude on VPS** |
| Autonomy | **Medium** for the first run |
| SSH alias | Your SSH alias, for example `my-vps` |
| Remote project | Your actual absolute Linux Git project path, for example `/home/<user>/projects/your-project` |
| Worker script installed on VPS | `/home/<user>/tools/duo/plugins/codex/scripts/remote-worker.mjs` if you used the copy commands above |
| VPS verification commands | Only the checks you explicitly want to run on the VPS |

Replace example paths with real prepared directories. Verify Claude's subscription sign-in directly in the VPS terminal before starting a run. A complete deployed worker/provider workflow has not yet been verified end to end.

The coordinator transfers reviewed Git snapshots and integrates remote changes without committing or resetting your local branch/index. Bundles are limited to 24 MB and can include Git history, so use a sanitized task repository; filename checks do not prove a bundle is free of secrets. Concurrent local edits prevent automatic overwrite. Remote jobs and worktrees are retained for recovery after disconnection.

The current SSH worker expects Linux. Moving the coordinator to the VPS changes what “local” means; it does not automatically make your Windows computer a supported remote worker.

## 7. Safety and troubleshooting

Known or suspected files containing real passwords, SSH private keys, tokens, or other secrets must never be opened/read by either agent, even for debugging or through a shell/script. Native SSH/provider clients may use their protected credentials internally for authentication without revealing contents to agents. Behavioral rules are not a universal technical access denial: use isolated accounts/workspaces and appropriate filesystem/network controls before processing sensitive material.

Online model requests send selected context to the configured providers. Duo is not an offline or zero-disclosure system, and regex redaction is not complete leak prevention. Keep the listener on loopback; do not publish the dashboard or put it behind an unauthenticated proxy.

| Symptom | What to check |
| --- | --- |
| npm reports missing `package.json` or missing script `web` in another project | Run `duo web` after the one-time installation step, or use the installed absolute Node entry point. Do not create or copy a project manifest just to start Duo. |
| A folder without Git has no unified diff | Expected: the Changes panel shows task-relative file status instead. VPS synchronization still requires Git. |
| Sign-in required or an expired/consumed link | Reuse an already authenticated browser session. If none remains, stop and restart the server, then use its new private link. |
| Port already in use | Select another port, for example `npm run web -- --port 3211`; do not stop an unrelated process. |
| Duo is already running for this workspace | Use the original instance or stop it before starting another. Changing ports does not permit a second coordinator for the same workspace. |
| CLI unavailable | Check the executable on that agent's execution host and in the environment used by the coordinator/SSH worker. The local status card can report a missing local Claude CLI even when Claude will run remotely. |
| Authentication or provider-credential error | Sign in directly on the correct host using the intended subscription. Do not paste, print, or transfer credential files. |
| Needs attention / usage limit | Inspect the recorded error, transcript, model, and operation before resuming or starting a new run. |
| Remote operation has unknown status | Inspect its existing job/checkpoint; do not blindly repeat a write or deployment. |
| Old controls still visible | Reload the page. Static HTML/JavaScript updates do not require a server restart; backend/policy changes do. |
| DEP0190 from an older running process | Restart Duo at a safe checkpoint to load the native-process fix. Do not hide warnings with `--no-deprecation`; production helpers now launch executables/known Node CLI entry points directly. |

## 8. Development checks and further documentation

The dashboard itself has no extra runtime dependencies. Building the repository requires its development dependencies and Codex CLI. If they are not installed, review the lockfile and use `npm ci --ignore-scripts`, then run the intended scripts explicitly.

Focused automated checks, without provider inference:

```sh
node --test tests/process.test.mjs tests/duo.test.mjs tests/duo-install.test.mjs tests/collaboration-folder.test.mjs tests/collaboration-lock.test.mjs tests/collaboration-language.test.mjs tests/collaboration-models.test.mjs tests/collaboration-policy.test.mjs tests/collaboration.test.mjs tests/collaboration-remote.test.mjs tests/web.test.mjs
npm run build
```

Run `npm test` for the full suite. Live account tests are opt-in and consume subscription allowance. See [verification evidence and outstanding limits](docs/verification.md) for the latest recorded results and platform-specific skips.

- [Complete collaboration guide](docs/collaboration.md)
- [Safety requirements and enforcement limits](docs/safety.md)
- [Shared policy loaded for both agents](plugins/codex/prompts/collaboration-rules.md)
- [Run-configuration template](AGENT_RULES.template.md)
- [Design plan](plan.md)

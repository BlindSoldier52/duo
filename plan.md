# Plan: Codex and Claude collaboration

> Historical design specification. It records the original intent and is not kept in sync with the implementation; see the [user guide](guide.md) for current behavior.

## 1. Intended outcome

Build Duo so Codex and Claude can analyze the same request, exchange proposals and objections, develop a shared plan, and independently review the implementation. The user follows the discussion and controls the level of autonomy.

Three modes are supported by the design: `Medium`, `Skip everything`, and `VPS–computer`. Communication is automatically orchestrated, with persistent sessions and visible history, without manually copying messages between applications.

The primary interface is a local web dashboard: the user talks to both agents, follows their exchange of views, and controls planning and execution from the browser. The CLI remains available and uses the same coordinator.

This document preserves the design specification. For the current implementation's actual behavior and commands, see the [collaboration guide](docs/collaboration.md). See the [safety guide](docs/safety.md) for policy requirements and enforcement limits.

Implementation status:

- Local dashboard, chat, editable plan, approvals, pause/cancel, and history: implemented.
- English agent responses by default, with a persisted per-run response-language setting and explicit user-request overrides: implemented and tested automatically.
- Adaptive model selection by both agents and additional passes with configurable limits: implemented and tested automatically; the new workflow has not yet been verified through live provider requests.
- `Medium` and `Skip everything`: tested automatically and through real Codex–Claude collaborations in temporary projects before the adaptive-model update.
- Git transfer, remote worktrees, and a worker with persistent jobs: implemented and tested locally.
- SSH access to a Linux VPS, Node.js, and the Claude Code installation there: confirmed through read-only checks. Worker configuration and a complete VPS–computer end-to-end check remain outstanding.
- Visual browser verification: not performed; the integrated browser was unavailable in the session.

Check the examples and extensions below against the guide before using them. The guide identifies the commands that are actually available.

## 2. Existing foundation and subscription access

The application reuses internal Git/process utilities, integration with `codex app-server`, persistent threads, ownership locks, jobs, and logs. Its public entry point is `duo.mjs`, with the web dashboard and collaboration controls described in the user guide.

The initial local inspection on October 21, 2026 found Claude Code `2.1.306` and Codex CLI `0.163.0`. Executables and `--help` options were checked at that stage. Subsequent authentication and live workflow evidence is recorded separately in [verification.md](docs/verification.md).

For OpenAI, use CLI authentication with the ChatGPT account. Codex CLI supports subscription access, while API-key usage has separate billing. Preserve the subscription route and report the authentication method without exposing credentials. See the official OpenAI documentation on [authentication](https://learn.chatgpt.com/docs/auth) and [plans and limits](https://learn.chatgpt.com/docs/pricing).

Claude Code supports authentication with a Claude Pro account. Opus 5.5 was the original requested starting model, selectable as `claude-opus-5-5`. The updated design uses adaptive selection by default: either agent may choose its own next model through its configured provider CLI. An initial model is not a permanent pin unless the user selects fixed-model behavior. Validate actual account access rather than assuming it. See [Claude Code authentication](https://code.claude.com/docs/en/authentication) and [model configuration](https://code.claude.com/docs/en/model-config).

For Codex, the initial model is configurable and otherwise follows the CLI default. Record requested identifiers and runtime-reported models separately for both participants. A new CLI session does not automatically inherit this application's current private conversation: it receives the task, relevant project context, and saved decisions.

Subscriptions have usage limits; the project does not promise unlimited runs. If access is unavailable or a quota is reached, save progress and report the condition without silently switching to paid API access. Adaptive selection never authorizes provider changes, purchases, or permission changes.

## 3. The three modes

| Mode | Agent workflow | Stopping point |
| --- | --- | --- |
| `Medium` | Analyze, discuss, and produce a shared plan. | Present the plan to the user; implementation waits for approval. |
| `Skip everything` | Discuss, plan, implement, test, and review each other's work. | Required checks pass and both agents approve the same final revision. |
| `VPS–computer` | Work across two machines with synchronized responsibilities and results. | Follow the explicitly selected `Medium` or `Skip everything` policy. |

The third mode separates execution location from autonomy. Configuration determines which agent runs on the VPS and which runs on the computer; the roles can be reversed where the configured environments support them.

### 3.1. Medium

1. The user supplies the task and acceptance criteria.
2. Both agents independently inspect the context with read-only project access.
3. Each presents its proposed approach, evidence, and relevant questions.
4. The coordinator forwards each proposal to the other agent; responses and revisions continue until a shared plan or an explicit disagreement emerges.
5. The plan includes the objective, affected files/components, implementation steps, verification, and unresolved decisions.
6. The coordinator preserves the plan and enters `awaiting_user`. File export is a design extension; consult the current guide for available controls.

The user may approve, edit, or reject the plan. Both agents reread and review an edited plan against the updated requirements; implementation waits for approval of the resulting revision. Rejection ends the run without implementation and preserves the history.

Approval is tied to the exact plan content through its hash. Later edits invalidate it. During discussion, only the coordinator writes conversation artifacts and any authorized plan export; agents do not modify source files or run project-mutating commands.

### 3.2. Skip everything

1. Both agents analyze the task and establish an internal plan and verifiable completion criteria.
2. They assign responsibilities. By default, one implements while the other independently reviews; roles may change between stages.
3. The implementation owner makes changes and performs permitted diagnostics; the coordinator executes configured verification commands.
4. The reviewer inspects the concrete result and verification evidence, then approves or reports reproducible problems.
5. Problems are corrected, affected checks are rerun, and both agents reassess the new revision.
6. The coordinator declares `completed` only after the criteria in section 6 are satisfied.

No routine plan approval or confirmation of every ordinary stage is required. Necessary permissions are established for the task's workspace and operations. This mode is a workflow policy, not a global activation of `--dangerously-skip-permissions`.

Production changes, publication, and destructive operations may run autonomously only when explicitly included in the task and its authorization. A material expansion beyond that scope saves state and requests the missing decision. Missing access, a runtime refusal, and failing tests are not success. The absolute prohibition on reading known or suspected secret-bearing files remains in effect.

### 3.3. VPS–computer

The minimum configuration includes an SSH alias, project paths on both machines, agent placement, and an autonomy policy. The initial layout is Codex on the computer and Claude on the VPS.

The coordinator runs on the computer and communicates over SSH with a Node.js worker on the VPS. The worker starts the CLI installed there and retains remote jobs. Do not expose the local broker through a public port or assume Windows named pipes are accessible from Linux.

Workflow:

1. Verify connectivity, CLI versions, authentication status without credentials, repository identity, and base revision on both machines.
2. Give each participant a suitable checkout/worktree based on the same revision and only the context needed for the task.
3. Assign ownership by file or component; a file has one writer at a time by default. Communicate interface changes before dependent work consumes them.
4. Transfer results using Git bundles and task-owned references/worktrees without requiring a push to a public service. Inventory relevant uncommitted changes and include only appropriate files in the snapshot. Protected secret-bearing files must not be read or transferred.
5. Integrate results without overwriting concurrent user changes, resolve task-related conflicts when authorized, and request review of the integrated result.
6. Run checks in the appropriate environment: for example, Windows checks on the computer and Linux/backend checks on the VPS. Identify the exact host and revision tested.

Configure authentication separately on each execution host. SSH must verify the server identity; tokens remain in native CLI stores and must not appear in messages, Git, or project configuration. Codex provides a documented headless authentication flow. See [OpenAI headless authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

Remote operations have identifiers and acknowledgments. After an SSH interruption, the worker retains state, and reconnection inspects the existing operation before starting another. Do not automatically repeat an operation with an unknown outcome if it could duplicate a write. Remote cancellation and process checks use the job identity, not only an unchecked PID.

### 3.4. Adaptive model selection

Both agents may choose their own next model within their existing provider subscription when the run uses `adaptive` selection. They may favor a smaller model for suitable bounded tasks, escalate to a more capable model, or request additional sequential passes with a concrete purpose. Ten smaller-model calls are an example, not a required strategy or a guarantee of lower total usage.

Model requests use structured `routing` responses. An additional-pass request makes the current verdict provisional; it cannot count as plan or final approval. Preserve phase restrictions, ownership, session continuity, and all safety rules across model changes.

The current defaults are 12 rounds and 12 calls per participant/phase extra-pass sequence, each configurable from 1 to 30. Fixed-model runs prohibit agent-requested changes. A failed selection or exhausted limit must not silently trigger indefinite retries, another provider, or paid API billing. Record requested and reported models separately.

## 4. Proposed architecture

```text
Browser: chat and controls       CLI / Claude Code / Codex
           |                              |
    Local web server                      |
    HTTP API + SSE events                 |
           \                             /
                Node.js coordinator
          /             \
  Codex adapter      Claude adapter
  app-server         Claude Code CLI
          \             /
       Messages, plan, results,
       checks, and approvals

In split mode, one adapter runs through the SSH worker.
```

The coordinator schedules rounds, retains history, and applies the selected mode's rules. Agents exchange messages through it and have separate persistent sessions. The coordinator must not attribute an opinion to an agent that has not responded.

The Codex adapter reuses `runAppServerTurn`, `persistThread`, `resumeThreadId`, `outputSchema`, progress reporting, and interruption. Continuing conversations through `thread/resume` and `turn/start` is documented in the official [OpenAI App Server guide](https://learn.chatgpt.com/docs/app-server).

Write phases must not use a broker fallback that silently reexecutes an entire turn after disconnection. An already-started turn must be reconciled with its checkpoint before retrying to avoid duplicate changes. The current collaboration adapter uses direct App Server connections rather than the legacy broker retry path.

The Claude adapter starts `claude -p`, applies an optional model selection, reads JSON output, and saves `session_id` for `--resume`. It uses the structured response schema and handles missing or invalid results explicitly. See [Claude Code programmatic execution](https://code.claude.com/docs/en/headless).

Start Claude with separate process arguments and the prompt on stdin, without concatenating it into a shell command. Do not use `--bare` for subscription authentication: the documented subscription route requires the normal authentication mechanism. See [Claude Code authentication](https://code.claude.com/docs/en/authentication).

Child processes receive an orchestrated-execution marker and controlled tools/hooks so they do not recursively start further collaborations. Relevant project instructions still apply. Effective permissions depend on the runtime and execution environment, not merely on the prompt.

Extend the existing CLI and utilities without introducing a new framework, external database, or additional runtime dependencies in the first version. The integration can be started through the same local command from either application; it does not imply automatic access to their private histories.

The web server is a local Node.js process that serves the interface and calls the coordinator directly. The browser displays data and sends user actions; CLI and SSH processes run only in the backend. Public hosting is not required to control the computer and VPS.

## 5. Messages and persistence

A collaboration has its own ID and retains the task, mode, acceptance criteria, participants and hosts, session IDs, rounds, plan and revision, artifacts, checks, and each agent's verdict.

The design message envelope includes identifiers, sender, recipient, phase, reply context, artifact revision, and content. Depending on the phase, a response carries a proposal, justified objections, evidence, next action, and an `approve`, `revise`, or `blocked` verdict. The current structured response also supports adaptive model routing; consult the implementation guide rather than treating every originally proposed envelope field as implemented.

Visible conversation contains proposals and useful justifications; it does not depend on extracting private internal reasoning. The coordinator verifies participant identity and revision through its own metadata rather than accepting them merely because a model mentions them.

Storage uses the existing state directory resolved by `state.mjs` and dedicated collaboration records. Reuse atomic writes and appropriate ownership locks. Avoid holding short-lived data-update locks across model requests; the coordinator also retains a separate ownership lock for its lifetime so another coordinator cannot concurrently control the same workspace.

Primary design states include `discussing`, `awaiting_user`, `implementing`, `reviewing`, `waiting_quota`, `needs_attention`, `completed`, `rejected`, and `cancelled`. The implementation also records scheduling, verification, and cancellation-in-progress states. Existing legacy job state remains separate and compatible.

History identifies the speaker, host, and phase, with persisted data available for inspection. After a restart, resume using recorded session IDs and operation checkpoints rather than implicitly choosing the most recent conversation.

## 6. Consensus and the definition of done

Verbal agreement alone does not complete the task. `completed` requires all of the following:

- Acceptance criteria are satisfied and supported by evidence.
- Required checks passed for the final revision in the relevant environments.
- Both agents independently approved the same integrated result revision.
- No operation remains in progress and no blocking issue remains unresolved.
- No later change invalidates the checks or approvals.

The result revision identifies relevant tracked and new files by hashes and the Git context. For non-code work, identify the deliverables and checks appropriate to the task. Checks that cannot be executed are reported as not run, not passed.

Each agent inspects evidence and may challenge the other's conclusion. A change invalidates affected approvals for the previous result. Split-mode approval applies to the integrated result, not just each participant's own branch.

The default limit is 12 discussion/correction rounds, configurable per run. Lack of convergence produces `needs_attention` with the disagreement and evidence, never forced approval. Additional-pass sequences have a separate configurable limit. Usage and time limits must not be confused with successful completion. At a subscription quota limit, preserve `waiting_quota`; resume explicitly according to the implemented controls. Scheduled resumption at a known reset time is a possible extension, not an implemented promise.

## 7. Web interface and proposed commands

### 7.1. Web dashboard

The user starts the application locally and opens the address printed in the terminal. The original design command was:

```text
node duo.mjs web --cwd . --port 3210
```

For the actual repository entry point, use the command in the [collaboration guide](docs/collaboration.md).

Initial layout:

```text
+--------------------------------------------------------------------------+
| Project   Mode   Codex: model / host   Claude: model / host   Status       |
+----------------+-------------------------------+-------------------------+
| Conversations  | Shared chat                   | Plan / Diff / Tests     |
| and tasks      |                               |                         |
|                | You -> both                   | Current revision        |
|                | Codex -> Claude               | Codex verdict           |
|                | Claude -> Codex               | Claude verdict          |
|                |                               |                         |
|                | Message... [Both v] [Send]    | [Approve] [Reject]      |
+----------------+-------------------------------+-------------------------+
| [Pause] [Resume] [Cancel]    Activity / hosts / checks                     |
+--------------------------------------------------------------------------+
```

First-version functionality:

- Shared chat: send messages to both agents, only Codex, or only Claude; identify sender, recipient, and host. The agents' discussion appears in the same thread, with technical activity in a separate panel.
- Tasks and history: create, select, and resume work with acceptance criteria and project context. Reloading the page must not lose the conversation or restart the task.
- Modes and placement: select `Medium`, `Skip everything`, or `VPS–computer`, models, and hosts. Record mode changes as explicit user actions and apply them at safe operation boundaries.
- Plan: view and edit the current plan, submit revisions for discussion, approve, or reject. Approval targets the exact displayed revision; an old plan cannot authorize a new one. A dedicated revision-comparison UI remains a design extension.
- Results: show changed-file status, diffs, recorded checks and their limitations, and both verdicts for the same revision. File previews and diffs are scoped to the configured project.
- Controls: pause, resume, and cancel with participant status. Pause stops new steps from being scheduled; cancellation requests interruption of active operations. Show the request separately from confirmation, including an unresponsive remote worker.
- Configuration: show CLI status, authentication method without secrets, workflow policy, round/pass limits, adaptive/fixed models, and SSH profile. Subscription authentication uses documented CLI flows, not passwords submitted through a custom form.

The UI uses HTML, CSS, and JavaScript with keyboard navigation, screen-reader labels, and responsive layout. Model text and tool output are displayed as data, without executing supplied HTML or scripts.

### 7.2. API and operation controls

The local API exposes explicit operations to list/create tasks, send messages, read events and artifacts, edit plans, approve/reject, pause, resume, and cancel. These use the same coordinator as the CLI; there is no endpoint that directly executes arbitrary shell strings.

Real-time updates use Server-Sent Events, and user actions use HTTP requests. Events have persistent IDs; reconnection resumes after the last received event. Messages and actions have idempotency keys so double-clicks and browser retries do not create duplicate operations.

By default, the server listens only on `127.0.0.1`. Access uses an authenticated local session, `Host` and `Origin` checks, CSRF protection, and an `HttpOnly` session cookie with `SameSite=Strict`. The port number is not authentication. Provider tokens and SSH private keys are never delivered to the browser.

Approval is accepted only through an explicit authenticated user action, not by interpreting an agent's message. The backend checks the revision and current state even if a browser button appears enabled. File-preview controls reject traversal outside the project. These controls do not constitute a universal file-access or network sandbox for every backend subprocess.

Closing the tab does not cancel the task: the coordinator continues and saves progress. Stopping the server checkpoints interrupted operations and requires inspection before resuming; uncertain remote outcomes remain explicit. For access from another device, use a separately configured authenticated private tunnel rather than publicly exposing the first-version listener.

### 7.3. CLI

The following original examples include proposed extensions and are not all implemented. Use the current guide to determine valid options and approval syntax.

```text
node duo.mjs collaborate start --mode medium --plan-output collaboration-plan.md "task"
node duo.mjs collaborate start --mode skip-everything "task"
node duo.mjs collaborate start --mode split --policy medium --remote vps-dev --codex-host local --claude-host remote "task"
node duo.mjs collaborate start --mode split --policy skip-everything --remote vps-dev --codex-host remote --claude-host local "task"

node duo.mjs collaborate status <run-id>
node duo.mjs collaborate transcript <run-id>
node duo.mjs collaborate revise <run-id> --plan collaboration-plan.md
node duo.mjs collaborate approve <run-id> --plan collaboration-plan.md
node duo.mjs collaborate reject <run-id>
node duo.mjs collaborate resume <run-id>
node duo.mjs collaborate cancel <run-id>
```

`Medium` is the default; `split` requires an explicit autonomy policy. `approve` authorizes implementation of the exact reviewed plan, using the current implementation's revision-bound approval. `revise` reopens discussion and returns to user approval. Any future file export must not silently overwrite an existing file. `--mode medium` is distinct from `--effort medium`.

Current collaboration options include `--cwd`, `--codex-model`, `--claude-model`, `--model-policy`, `--json`, `--max-rounds`, and `--max-passes`. Adaptive selection is the default; initial model fields may be omitted to use CLI defaults. Remote configuration uses an SSH alias and absolute paths; neither the profile nor CLI arguments may contain secrets. Additional time-limit controls remain design work unless documented as implemented.

## 8. Implementation sequence

### Stage 1 — Setup and contracts

Extend setup checks for both CLIs, authentication methods, and requested models. Define response schemas, states, consensus criteria, and remote profiles. A short live test validates each participant during implementation/setup before launching a full collaboration.

### Stage 2 — Local conversation and Medium

Add the Claude adapter and coordinator, reuse the Codex adapter, and connect the `collaborate` command group. Implement rounds, history, plan handling, editing, revision-bound approval, rejection, and resume. This is the first functional backend deliverable.

### Stage 3 — Local web dashboard

Add the HTTP server, API, SSE events, and controls for chat, mode selection, planning, and task execution. Connect the UI to the real backend from stage 2; simulated responses belong only in tests and must never be presented as actual agent replies. The first complete browser workflow is `Medium`: task, discussion, editable plan, and user decision.

### Stage 4 — Skip everything

Add implementation ownership, independent review, correction loops, and consensus checks for final artifacts. Integrate interruption and timeout handling for both participants; verify that stopping one agent cannot make the other report agreement.

### Stage 5 — VPS–computer

Implement the SSH worker, remote checkpoints, Git transfer, and integration through owned worktrees. Verify supported placements and both autonomy policies. Configure the actual VPS alias and project paths during setup; writing this plan does not require deployment.

### Stage 6 — Integration and documentation

Update Duo's CLI help, README, and usage examples. Preserve existing internal compatibility utilities without making them a setup requirement for Duo. The web UI and CLI use the same coordinator.

### Stage 7 — Adaptive models and safety policy

Allow both participants to request their own next model and additional bounded passes. Record provisional responses and requested/reported model history, preserve restart checkpoints, and expose initial-model and policy settings in the dashboard/CLI.

Load the same detailed English behavioral rules for both participants, including the absolute no-read requirement for known or suspected secret-bearing files. Document the distinction between prompt requirements and technical isolation rather than claiming complete leak prevention or error-free model behavior.

## 9. Files affected by the implementation

| Area | Proposed or implemented responsibility |
| --- | --- |
| `duo.mjs` | Public Duo CLI entry point and help for `collaborate` and `web`. |
| `plugins/codex/scripts/lib/claude.mjs` | Claude processes, structured output, sessions, models, and errors. |
| `plugins/codex/scripts/lib/collaboration.mjs` | Coordination, rounds/passes, model routing, approvals, and consensus. |
| `plugins/codex/scripts/lib/collaboration-state.mjs` | Persistent collaboration checkpoints and messages. |
| `plugins/codex/scripts/lib/collaboration-protocol.mjs` | Structured responses, model-request validation, and shared helpers. |
| `plugins/codex/scripts/lib/codex.mjs` | Persistent App Server turns and connection/interruption handling. |
| `plugins/codex/scripts/lib/web-server.mjs` | Local HTTP server, API, sessions, and SSE events. |
| `plugins/codex/web/` | HTML, CSS, and JavaScript for chat and controls. |
| `plugins/codex/scripts/remote-worker.mjs` | Remote worker and durable SSH operations. |
| `plugins/codex/scripts/lib/collaboration-remote.mjs` | SSH adapter and remote result integration. |
| `plugins/codex/prompts/` | Shared English collaboration and safety instructions. |
| `tests/` | Fixtures and tests for coordination, model routing, policy inclusion, the web API, and remote transport. |
| `README.md` and `docs/` | Setup, workflow modes, policy boundaries, and actual verification evidence. |

Change the broker only if integration requires a concretely identified missing capability. Do not rewrite the existing Codex transport. Any release-version update is a separate operation using the existing project script.

## 10. Implementation verification

Automated tests use simulated agent responses without consuming subscriptions. They exercise bidirectional messaging through the coordinator, session continuity, invalid responses and refusals, revision-bound approvals, and disagreement handling.

For `Medium`, verify that agents do not modify source files before approval, plan edits invalidate previous agreement, and rejection does not start implementation. For `Skip everything`, verify the implement–review–correct loop and the impossibility of completing with failed required checks, a missing agent, or stale approvals.

For split mode, test transfer from the same base, safe integration, Windows/Linux differences, interrupted/reconnected SSH without blind duplicate execution, and remote cancellation. Keep collaboration state independent of legacy SessionEnd cleanup so ending a child session cannot silently discard an active collaboration.

For the web interface, verify the `Medium` workflow, targeted message routing, plan editing/approval, real-time progress, pause, and cancellation in a browser when available. Test stale revisions, unauthenticated requests, rejected origins, paths outside the project, and duplicate actions through the API. Check SSE reconnection, reload without lost or duplicated messages, safe text rendering, and keyboard controls. HTTP/static checks do not replace visual browser verification.

For adaptive selection, test independent model choices, ten-pass sequences without mandatory repetition elsewhere, configurable limits, fixed-model behavior, unavailable models, provisional approvals, unchanged ownership and permissions, pause/resume, durable model checkpoints, and remote argument forwarding. Synthetic tests do not prove current account access or relative model costs.

Run the existing suite and build, and distinguish baseline failures from regressions using evidence. Complete small live checks for supported workflows with configured accounts, retained transcripts, and both actual verdicts. A real split-mode check requires the VPS. Report untested behavior explicitly; consult [verification.md](docs/verification.md) for what was actually checked.

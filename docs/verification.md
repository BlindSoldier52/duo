# Collaboration verification

Verified on Windows with Node.js 24.16.0, Codex CLI 0.163.0, and Claude Code 2.1.306 on October 21, 2026.

## Automated checks

- 78 tests passed across `process.test.mjs`, `duo.test.mjs`, `duo-install.test.mjs`, `collaboration-folder.test.mjs`, `collaboration-lock.test.mjs`, `collaboration-language.test.mjs`, `collaboration-models.test.mjs`, `collaboration-policy.test.mjs`, `collaboration.test.mjs`, `collaboration-remote.test.mjs`, and `web.test.mjs` after the plain-folder and AppData installation updates, without DEP0190 warnings in this focused run.
- `npm run build` passed, including App Server type generation through the portable prebuild script.
- `npm run check-version` passed; release metadata remains at 1.0.25.
- JavaScript syntax checks and `git diff --check` passed.
- The running local HTTP server returned status 200 for the dashboard.

The new tests exercise plan revision approval, independent votes, failed verification, targeted messages, queue serialization, pause/cancel, shutdown recovery, one-time browser authentication, CSRF/Origin/Host checks, event replay, file preview boundaries, process arguments, Git snapshot transfer, binary-safe idempotent integration, and persisted worker verification.

The three policy tests additionally verify that both participants receive the full bundled policy in each agent phase, peer text remains attributed below it, and independent proposal context excludes peer claims. These are prompt-construction tests, not live adversarial model evaluations or proof against hallucination/exfiltration. No new provider inference was used for the policy update. Earlier Windows test runs emitted Node's `DEP0190` warning; the native-process update below addresses the identified application paths rather than suppressing that warning. Passing tests do not establish that every command or external script is safe.

The twelve model-routing tests cover independent model changes, ten-pass scheduling, later-phase choices, pass limits, fixed models, invalid identifiers, unavailable selections, repeated implementation, pause/resume, Claude CLI argument construction, provisional final verdicts, checkpointed restart, and remote request forwarding. Provider responses are synthetic in these tests. The build passed after the routing change; the earlier live workflows below predate this change and are not evidence of a new live adaptive-model run or actual relative model costs.

The English-interface test checks the served document language, visible control labels, accessibility text, and dynamic-message strings. Additional checks confirmed that the running server serves the English HTML/JavaScript, JavaScript syntax is valid, and all six local README links resolve. These checks do not replace interactive or visual browser verification; another browser discovery attempt returned no available browsers.

Five language tests verify the English default for both agents, custom language names/codes, validation, idempotent setting changes without rerunning implementation, preserved approvals, persisted preferences after restart, fallback for legacy records, and refusal to alter active operations. A further HTTP test verifies authenticated language changes and API persistence. These tests inspect prompt construction and coordinator behavior with synthetic responses; they do not prove that every live model follows a natural-language preference. The build also passed after this update.

Three public-entry tests verify Duo-branded help, actionable unsupported-command errors, and consistent user-facing documentation/package/dashboard branding. The build and version-consistency checks also passed. Internal compatibility paths and identifiers remain stable, and license/copyright notices are preserved.

Four ownership-lock tests verify immediate rejection of another coordinator without taking an old but live lock, nonzero exits for actual duplicate web/standalone CLI processes even on another port, automatic recovery of a valid lock left by an exited process, and replacement after shutdown with independent workspaces. The duplicate-process integration test also confirms the original HTTP server remains responsive. The build passed after the lock change; no provider inference was required.

Seven process tests cover Windows tree termination, literal argument boundaries/metacharacters, npm-style CLI support, quoted PATH entries, refusal of unsupported earlier batch wrappers, and a subprocess running native CLI checks plus simulated direct App Server initialization under `--throw-deprecation`. A separate real Codex version probe and direct App Server initialize/close check also passed with deprecations treated as errors and without requesting inference. The build passed after this change. This is not a new live adaptive-model or VPS execution test.

Ten folder tests cover Medium and Skip everything without Git or a project manifest, revision-bound checks and votes, persisted task-relative file status, same-size/timestamp-preserving edits, read-only phase enforcement, credential/dependency path exclusions, directory-symlink boundaries, missing Git on PATH, empty local Git repositories, explicit rejection of unsupported Git-free VPS synchronization, authenticated HTTP task creation/artifacts, and startup from a foreign working directory with a different parent `package.json`. Provider replies are synthetic. A local `npm link` registered the public `duo` command; `duo help` ran successfully from the user's non-Git project folder. A short-lived HTTP server also returned 200 and authenticated bootstrap identified that folder correctly, without provider inference or project-content reads. The temporary server was closed. No real provider implementation was requested in that folder.

Seven installation tests cover AppData/XDG paths and overrides, self-contained app copying and HTTP startup without the source checkout on module paths, absence of bundled dependencies/projects, state-preserving updates with application backups, refusal to replace a live coordinator, non-overwriting legacy state migration with retained originals and cross-version ownership locks, and installation/startup serialization with a centralized transfer cache. These are local filesystem and synthetic-state tests; no provider authentication files or real credentials are read or copied.

## Live account checks

Both CLI adapters completed real structured-response requests through existing subscription logins. Claude reported `claude-opus-5-5`.

Two opt-in live workflows passed in temporary Git projects using GPT-6 Luna and Claude Opus 5.5:

1. Medium: independent proposals, a synthesized plan, persistent conversation sessions, both plan-review approvals, and a stop at `awaiting_user`.
2. Skip everything: planning, implementation of a small file, a real verification command, and both final approvals for the same revision.

These runs consumed subscription allowance. The ordinary automated test suite does not run them unless their environment flags are explicitly enabled.

## Responsiveness update

This update made questions stop reopening planning, ran independent agent steps in parallel, delivered the shared rules once per session, cached workspace file digests, reused the Codex app-server, streamed Claude tool progress to the dashboard, and fixed several reliability and accessibility problems. Afterwards the full suite on this Windows checkout had 204 tests: 199 passed, 2 were skipped, and 3 failed. Two failures need symlink permission (Windows developer mode or administrator rights), and one simulates a Unix socket path on Windows. A test helper that broke paths containing spaces was also fixed, which cleared most of the earlier legacy failures.

A small live check used the real CLIs in a temporary Git folder. Claude (haiku) confirmed it received the rules through `--append-system-prompt-file` and streamed `Read notes.txt` as progress. Codex confirmed it received them as developer instructions; a resumed second turn reused the same app-server process and took 3.7 seconds against 17.3 seconds for the first. Both opt-in live workflows were then run with the real CLIs (Codex gpt-6-luna, Claude CLI default). Medium passed in 34 seconds. The first Skip everything run exposed a regression: the reused Codex app-server kept the read-only sandbox from the planning turns, so implementation could not write. Codex now restarts its app-server whenever the sandbox mode changes, and the rerun passed in 74 seconds with a passing check and both final approvals for the same revision.

The dashboard was also driven in headless Chrome over the DevTools protocol with simulated agents: it loaded, listed all three recipients, showed both agents working in parallel with live activity, kept focus on the selected conversation, announced status changes, and logged no console errors. A screen-reader session was not tested.

After a later round of fixes, the full suite had 207 tests: 203 passed, 4 were skipped (the two opt-in live tests and two symlink tests that skip without administrator rights), and none failed. The two symlink tests passed when run as administrator.

## Remaining verification limits

Earlier Windows runs of the legacy test suite failed on shell handling of paths containing spaces, Windows ESM paths used without file URLs, symlink permissions, and platform assumptions. The most recent full-suite run recorded above had no failures; symlink tests still skip without administrator rights or Windows developer mode, and opt-in live tests skip unless their environment flags are set.

No visual or interactive browser QA was completed because the Browser integration reported that no browser was available. HTTP endpoint and static asset checks passed, but they do not replace that verification.

Git bundles, worktree preparation, and background worker verification were exercised locally. A read-only SSH check against a Linux VPS with strict host verification confirmed that Node.js, Git, and Claude Code were present. It did not verify Claude authentication, deploy the application, or complete a real SSH worker/provider end-to-end run; those checks remain outstanding.

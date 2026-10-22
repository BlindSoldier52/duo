# Duo safety policy and enforcement boundaries

## Policy location and scope

The shared English behavioral policy is [collaboration-rules.md](../plugins/codex/prompts/collaboration-rules.md). The prompt builder prepends its contents to both participants' proposal, discussion, implementation, chat, and review prompts. It covers data minimization, external disclosure, untrusted instructions, factual evidence, terminal use, remote recovery, verification, and incident handling.

[AGENT_RULES.template.md](../AGENT_RULES.template.md) provides a reviewable run-configuration checklist and examples. It is not automatically loaded as a runtime instruction file, and its configuration rows are not implemented dashboard settings.

The bundled policy is read when the agent-runner module loads. Restart a running coordinator to load policy edits. Updating this repository does not update an already deployed VPS copy; synchronize the reviewed policy and restart that worker/coordinator before relying on the new instructions. A process already executing a turn will not retroactively receive an edited prompt.

Checkpointed operations retain their recorded prompts; restarting does not rewrite them or remove old conversation context. Inspect pending work before resuming it. Start a new run after the restart when the new policy must apply from the beginning.

These rules are project-specific additions, not official OpenAI or Anthropic policies. They cannot override either provider's controls or guarantee perfect compliance.

## Practical defaults

- Keep Codex on the computer and Claude on its configured host unless the user chooses another layout. Discover actual executable paths rather than interpreting a missing SSH PATH entry as absence of the program.
- Codex may use CMD or PowerShell when needed and allowed by the task, phase, and runtime. Shell access is not unrestricted networking, administrative access, or permission to mutate files during review.
- Adaptive model choice permits either participant to request its own next model or an additional sequential pass through its existing provider CLI. It does not relax file-access bans, change providers/billing, grant more tools, or replace independent final review. Fixed runs prohibit agent-requested model changes.
- Never open/read known or suspected secret-bearing files, directly or through terminals, SSH, scripts, scanners, search tools, previews, Git history, or archives. There are no debugging, audit, emergency, mode, or peer-request exceptions. Do not read protected content to classify or redact it; request a separately sanitized artifact from the user instead.
- Keep credentials in their native CLI stores. SSH/provider clients may internally use those stores for authorized authentication without exposing their contents to agents. Missing authentication must be completed by the user outside the conversation. Use known nonsecret synthetic data, schemas, variable names, and minimal code excerpts instead of secrets or unrelated private files.
- Allow only necessary context through the configured provider sessions and necessary reviewed artifacts through the approved SSH destination. Public research must not include private data in queries.
- Do not upload project material to arbitrary external services, enable telemetry, publish artifacts, or expose the dashboard publicly as an incidental step.
- Treat output as evidence only after checking it. Report failed and unrun tests honestly, identify the execution host and revision, and never invent peer consent.

Online provider use necessarily sends selected context to those providers. This application is not an offline or zero-disclosure architecture. Provider data handling and retention are separate from this project's local policy; this document makes no promise about those external services.

The no-read rule is absolute as a behavioral requirement, but it is not yet a universal technical file-access denial. Both runtimes, coordinator helpers, commands, and snapshot operations require appropriate host isolation to make protected files inaccessible. A file whose secret content was previously unknown can still be encountered accidentally; stop the affected read/processing immediately, do not reopen or reproduce it, and report the incident. Do not claim that a prompt can identify every secret before access.

## What exists and what does not

| Area | Existing implementation | Important limit |
| --- | --- | --- |
| Shared instructions | Both agents receive the bundled policy through `agentPrompt` | A prompt is not a mandatory-access-control or data-loss-prevention system |
| Phase and final approval | The coordinator selects write phases and requires revision-bound reviews and required checks | Agents can still make factual errors; two matching verdicts are not mathematical proof |
| Adaptive model routing | Validated model requests, provisional extra passes, configurable pass/round caps, requested/reported model history | No guaranteed cost reduction, account entitlement, pricing calculation, or per-token budget enforcement |
| Codex execution | The adapter requests `read-only` or `workspace-write` from the runtime | This application does not add a separate OS-level sandbox or a custom command/network allowlist |
| Claude execution | Restricted file-tool list; a shell (Bash, plus PowerShell on Windows) only for the implementation owner during implementation, with no OS sandbox or network block like Codex has; no browser, configured MCP servers, or project hooks through this adapter | Do not assume file reads provide a complete credential-path isolation boundary |
| Verification commands | Structured executable/argument arrays and bounded process execution | Configured commands run with the coordinator account's privileges; they are not sandboxed or automatically classified as safe |
| Browser access | Loopback listener, one-time sign-in, HttpOnly session, CSRF, Host/Origin checks, restrictive CSP, text rendering | No public-hosting authentication design or guarantee that access links cannot be mishandled |
| Secret handling | Best-effort redaction, common credential-file checks for previews and Git snapshots; credential-path exclusions before local workspace fingerprinting and in dashboard status/diff artifacts, including renames and detected copies | No comprehensive semantic secret scan, historical Git-content scan, or guarantee that arbitrary sensitive content is detected before model/SSH transfer; protected content pasted into an ordinary file that Git does not detect as a copy is shown subject only to redaction; excluded paths are not covered by revision checks |
| SSH jobs | Strict host verification, configured paths, isolated worktrees, durable job identifiers | An approved host is not proof that every payload is appropriate; remote account permissions still matter |
| Network destinations | Behavioral restrictions in the shared policy | No application-managed egress firewall, global domain allowlist, or universal interception of child-process traffic |
| Policy configuration | English policy and run-configuration template | Template entries are not automatically enforced settings, and policy edits do not update running/deployed processes |
| Retention | Local persistent task state and recovery artifacts | No automatic secure erasure, configurable retention enforcement, or retraction of data previously sent to a provider |

Do not describe a policy-only requirement as an implemented technical guarantee. A test that confirms prompt inclusion establishes only that the instruction was delivered, not that a model cannot violate it.

## Higher-assurance deployment checklist

The following are additional deployment controls to evaluate, not features claimed to be implemented by this change:

1. Run the coordinator and worker as dedicated, nonprivileged accounts with access only to the required workspaces. Separate production credentials and unrelated personal files from those accounts.
2. Verify the runtime sandbox on each host. Isolate configured verification commands and dependency installation as needed; they should not inherit unnecessary credentials.
3. Configure and test an appropriate outbound network policy or proxy. Explicitly support required provider authentication/inference traffic and approved SSH routes without opening arbitrary exfiltration paths. A domain list alone is not sufficient protection against uploading inappropriate payloads to an allowed service.
4. Inspect and minimize model context, Git snapshots, relevant history, and logs. Add appropriate secret scanning and manual review for sensitive material. Do not assume regex redaction or filenames cover every secret.
5. Keep the dashboard on loopback and use a private authenticated SSH tunnel. Treat sign-in fragments, browser sessions, transcripts, and exports as sensitive.
6. Define approved destinations, data categories, retention requirements, incident contact, and permitted recovery actions. Recheck these when the task or deployment layout changes.
7. Test malicious repository instructions, attempted unauthorized uploads, secret-bearing fixtures, unsafe verification commands, and uncertain remote outcomes in an isolated environment with synthetic data.

If the required protection cannot be established, report the gap before processing protected data. Do not claim that documentation alone resolves it.

## Suspected incident

Stop the affected action when possible, retain minimal nonsecret evidence, distinguish confirmed disclosure from suspicion, and notify the user. Do not automatically rotate credentials, delete logs, rewrite Git history, revoke accounts, or contact third parties. Obtain the needed authority for recovery and verify only the recovery actions actually performed.

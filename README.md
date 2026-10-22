# Duo

A private web workspace where Codex and Claude discuss tasks, develop a shared plan, implement authorized changes, and independently review the result. Control both agents from one conversation, on your computer or across your computer and a Linux VPS.

## Start

You need Node.js 22.4 or later and the appropriate CLI signed in on each agent's execution host. Git is optional for local tasks and required for VPS synchronization. Install once from this checkout:

```sh
node duo.mjs install
```

Then run `duo web` from your project folder. On Windows, the installed application, policy, interface, and guide load from `%APPDATA%\duo\app`; conversation state and transfer cache use `%APPDATA%\duo\state` and `%APPDATA%\duo\cache`. The installed application does not depend on this checkout remaining in place.

Open the private sign-in link printed in the terminal. Keep the terminal open; press Enter there whenever you need a new sign-in link. No PHP, frontend build, or additional runtime dependencies are required.

Duo detects Git automatically; local projects do not need Git or `package.json`. See [the guide](guide.md#start-from-any-folder) for details. `npm run web` remains available in the source checkout for development.

## Usage

Read [guide.md](guide.md) for step-by-step setup, your first task, workflow modes, model selection, response languages, VPS configuration, safety, and troubleshooting.

- **Medium:** review and approve the shared plan before implementation.
- **Skip everything:** let the agents implement, verify, and review within the task's authorized scope.
- **VPS–computer:** run one agent on a configured Linux VPS over SSH.

The interface and default agent response language are English. Each conversation has a configurable response language. Both agents can select their own models and request additional bounded passes without gaining permissions.

Duo lets two AI agents run commands on your machine. In Skip everything mode they implement and verify changes without asking for approval at each step. Codex runs inside its own sandbox, but the shell Claude receives during implementation has no operating-system sandbox, so use Duo only on projects and machines where that is acceptable. Each agent runs through its official, unmodified CLI and signs in with your own account; Duo never handles your provider credentials, and your usage counts against your own plans.

For terminal controls, run `node duo.mjs help`. See [the collaboration reference](docs/collaboration.md), [safety boundaries](docs/safety.md), and [verification evidence](docs/verification.md) for details. Behavioral rules do not replace filesystem isolation or network controls; do not expose the dashboard publicly.

## Contributing and license

Duo is open source under the [Apache License 2.0](LICENSE). It is derived from OpenAI's original work; see [NOTICE](NOTICE) for attribution. Files from the original project have been modified for Duo, and Duo is not affiliated with or endorsed by OpenAI or Anthropic. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

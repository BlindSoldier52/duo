# Contributing to Duo

Thank you for helping improve Duo. Small, focused pull requests with tests are the easiest to review.

## Development setup

- Node.js 22.4 or later. Agent windows rely on Node's built-in WebSocket client.
- Git.
- Codex CLI, only for `npm run build`, which generates App Server types from it.

Review `package-lock.json`, then install development dependencies without running package scripts:

```sh
npm ci --ignore-scripts
```

## Checks

Run these before opening a pull request:

```sh
npm run check-version
npm test
npm run build
```

`npm test` uses synthetic provider responses and never contacts Codex or Claude. Some symlink tests skip without administrator rights or Windows developer mode.

Two opt-in live tests use your real CLI subscriptions and consume usage allowance. They run only when you set `DUO_LIVE_TEST=1` (Medium planning) or `DUO_LIVE_WRITE_TEST=1` (Skip everything implementation). Leave them off unless you intend to spend that allowance.

To change the release version, run `npm run bump-version <version>`; it keeps `package.json`, `package-lock.json`, and the plugin manifest in sync.

## Guidelines

- Follow the style of the surrounding code; avoid unrelated refactors.
- Add or update tests for behavior changes.
- Never commit secrets, real credentials, personal host names, IP addresses, or account-specific paths. Use placeholders such as `my-vps` and `/home/<user>/...` in documentation, and synthetic values in fixtures.
- Do not weaken authentication, CSRF, Host/Origin checks, protected-path filtering, or tests to make something pass.
- The shared agent rules live in `plugins/codex/prompts/collaboration-rules.md`.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

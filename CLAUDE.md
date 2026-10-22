@README.md

To change the version, run `npm run bump-version <version>`. It updates `package.json`, `package-lock.json`, and `plugins/codex/.claude-plugin/plugin.json` together, and `npm run check-version` confirms they match.

The Duo agent rules live only in `plugins/codex/prompts/collaboration-rules.md`; the coordinator sends that file to both agents as system instructions.

# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately using the repository's private security advisory feature ("Report a vulnerability" on the Security tab). Do not open a public issue for an unfixed vulnerability.

Include the affected version, steps to reproduce, and the impact you observed. Never include real credentials, tokens, or private data in a report; use synthetic values.

## Deployment expectations

- The dashboard listens on `127.0.0.1` and requires a one-time sign-in link, a session cookie, and CSRF tokens. Keep it on loopback. Do not expose it publicly or place it behind an unauthenticated proxy.
- Treat the printed sign-in link as a credential.
- Duo sends selected project context to the configured model providers. Pattern redaction and protected-path filtering reduce, but do not eliminate, the risk of disclosing sensitive content. Use sanitized repositories and isolated accounts for sensitive work.
- For VPS mode, keep strict SSH host-key verification enabled and do not run the worker as root.

See [docs/safety.md](docs/safety.md) for the full safety boundaries.

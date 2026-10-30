# Security Policy

## Supported Versions

llama-paddock is pre-1.0. Security fixes go into the next release from `main`; older releases are not patched, so the fix is to upgrade.

| Version | Supported |
| ------- | ------------------ |
| Latest `0.x` release | :white_check_mark: |
| Older `0.x` releases | :x: |
| Prereleases (`x.y.z-dev.N`, `:dev` image) | :x: — fixes land here first, but use a stable release in production |

This covers the dashboard (Docker image and release tarball), the Linux and Windows agents, and the install scripts in `install/`.

## Reporting a Vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub: go to the [Security tab](https://github.com/SplendidChip758/llama-paddock/security) and click **Report a vulnerability**.

Please include:

- the component and version (dashboard, agent, installer; `/api/healthz` shows the dashboard version),
- how it's deployed (Docker, Proxmox LXC, from source) and any relevant settings, such as `PADDOCK_AUTH=off`,
- steps to reproduce, or a proof of concept,
- what an attacker gains (read stats, change Ollama settings, run commands on a host, …).

### What to expect

This is a hobby project maintained in spare time, so these are targets, not guarantees:

- **Acknowledgement** within 7 days.
- **Assessment** within 14 days: whether it's accepted as a vulnerability, and how severe.
- **Updates** at least every 14 days until it's resolved.
- **If accepted:** a fix is released as a patch version, a GitHub security advisory is published with it, and you're credited unless you'd rather not be.
- **If declined:** you'll get an explanation. If it's a hardening suggestion rather than a vulnerability, you may be asked to open a regular issue.

Please give a reasonable window, normally up to 90 days, for a fix to ship before disclosing publicly.

### In scope

- Bypassing the dashboard login or session handling.
- Calling the agent API without a valid `PADDOCK_AGENT_TOKEN`.
- Command or path injection through the agent (environment edits, restarts, logs) or the dashboard.
- Leaking tokens, passwords or `auth.json` contents.
- The install scripts doing something unsafe, such as weak file permissions on secrets or downloading assets without checksums.

### Out of scope

- Deployments where the login has been turned off with `PADDOCK_AUTH=off` and no other authentication sits in front of the dashboard.
- Exposing the dashboard or agent to the internet without TLS. Both are designed for a trusted LAN or a reverse proxy. See the [installation guide](docs/installation.md#add-your-ollama-hosts) for network setup.
- Ollama itself, which has no authentication of its own. Report those issues [upstream](https://github.com/ollama/ollama/security).
- Vulnerabilities in dependencies that aren't reachable in llama-paddock. Dependabot already bumps these weekly.

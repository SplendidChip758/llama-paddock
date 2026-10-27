<!--
PR title = the squash-merge commit = the changelog entry, so it must be a
Conventional Commit, e.g. "feat(dashboard): show VRAM headroom on the model card".
See CONTRIBUTING.md. Open feature and fix PRs against `dev`, not `main`.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link issues with "Closes #123". -->

## Area

<!-- Tick what this touches. -->

- [ ] Dashboard
- [ ] Linux agent
- [ ] Windows agent
- [ ] Install scripts
- [ ] Docker / CI
- [ ] Docs only

## How it was tested

<!--
What you ran and on what, e.g. "npm run typecheck && npm run build",
"docker compose up against an Ubuntu 24.04 agent with 2× RTX 3090",
"installer in a fresh Proxmox 9 LXC (Debian)".
-->

## Screenshots

<!-- For UI changes. Delete this section if it doesn't apply. -->

## Checklist

- [ ] PR title is a valid Conventional Commit, with `!` if it's a breaking change
- [ ] Targets `dev` (or `main` for an urgent hotfix)
- [ ] `cd dashboard && npm run typecheck && npm run build` passes, if the dashboard changed
- [ ] Agent changes keep the Linux and Windows agents' API in step
- [ ] README / CONTRIBUTING updated for new settings, env vars or behaviour
- [ ] No tokens, passwords or personal hostnames/IPs in code, logs or screenshots

## Breaking changes

<!-- What users must do when upgrading (config, env vars, agent/dashboard versions). Delete if none. -->

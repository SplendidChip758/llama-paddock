---
applyTo: "install/**"
---

# Installers (`install/`)

Bash one-liners that users pipe from `raw.githubusercontent.com`. `dashboard.sh` and `agent.sh` install on a Proxmox VE host (creating an LXC and re-running themselves inside it) or directly on Debian/Ubuntu. `dashboard-dev.sh` is the prerelease wrapper.

## Rules

- **They are served from the `main` and `dev` branches, not from releases.** A merged change is live for everyone immediately, and `update-llama-paddock` re-runs the latest script from the branch. Changes must work for fresh installs and for updates of every existing install.
- `set -euo pipefail`. Report progress with `msg_info` / `msg_ok` / `msg_warn` and fail with `die`, keeping the existing tone.
- Every question must also work unattended (`PADDOCK_YES=1`, or no `/dev/tty`), with a safe default. Use the script's own prompt helpers (`ask`, `confirm`, plus `choose` and `ask_secret` in `dashboard.sh`). In `dashboard.sh` they show whiptail dialogs when available and plain text prompts with `PADDOCK_TUI=0` or no whiptail. Keep both modes working.
- Options are `PADDOCK_*` or `CT_*` env vars. Document new ones in the script's header comment and in the matching page in `docs/install/`.
- On a Proxmox host the script re-runs itself inside the new CT with `PADDOCK_NESTED=1` and must pass every option through. Anything shown once (header, disclaimers) is skipped when nested.
- Re-running keeps the user's config, data and tokens. Never overwrite `/etc/llama-paddock` or `/var/lib/llama-paddock` files that already exist.
- Destructive actions (uninstall, `pct destroy`, purging data) need an explicit confirmation, default **no**.
- Hide noisy command output with `quiet`, so it's shown only on failure.
- Keep `NODE_MIN` in step with what the dashboard or agent needs.

## Checks

```bash
for f in install/*.sh; do bash -n "$f"; done
```

Also run `shellcheck` if it's available. For changes to the install flow, test in a throwaway LXC or VM (and on a Proxmox host for `pct` changes), and say in the PR what you ran.

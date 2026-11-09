# Updates, backups and troubleshooting

Keep llama-paddock up to date, back it up, try prereleases, remove it, and fix common problems.

## Updates

Back up your data before upgrading, especially when changing release channels.

| Installation | Update |
|---|---|
| Dashboard installer | Run `update-llama-paddock` inside its container/VM, or `pct exec <ctid> -- update-llama-paddock` from Proxmox. It stays on the channel you installed from; see [Update channels](#update-channels) |
| Docker Compose | Run `docker compose pull` then `docker compose up -d` from the Compose directory |
| Linux agent | Run `update-llama-paddock-agent` on the Ollama host, or `pct exec <ctid> -- update-llama-paddock-agent` from Proxmox. It follows the same [update channels](#update-channels) as the dashboard updater |
| Windows agent | Extract `llama-paddock-agent-windows.zip` from the new [Windows agent release](https://github.com/SplendidChip758/llama-paddock-win-agent/releases) and re-run `install.ps1` from the same account; see [Windows updates](agent-windows.md#settings-and-updates) |
| Source | Update your checkout and repeat the [build steps](installation.md#from-source) |

Installer updates keep configuration and existing agent tokens. Docker updates retain the data volume.

### Update channels

`update-llama-paddock` (dashboard) and `update-llama-paddock-agent` (Linux agent) take the same optional argument:

| Command | Installs |
|---|---|
| `update-llama-paddock` | The newest release on the channel this install already follows |
| `update-llama-paddock stable` | The newest stable release, and switches the install to the stable channel |
| `update-llama-paddock dev` | The newest release including [prereleases](#prereleases), and switches the install to the prerelease channel |
| `update-llama-paddock v0.8.0` | That exact release. A prerelease tag (`v0.9.0-dev.3`) puts the install on the prerelease channel, a stable tag on the stable channel |

If the install is already on the release the command would fetch, the updater says so and stops: nothing is downloaded, and the dashboard or agent isn't restarted. It still goes ahead when the service isn't running, to bring it back. To reinstall the same release anyway (to repair an install, say), set `PADDOCK_FORCE=1`: `PADDOCK_FORCE=1 update-llama-paddock`.

An install follows the channel it was installed or last switched to, so a prerelease install keeps getting prereleases and a stable one keeps getting stable releases. The channel is not shared between the dashboard and its agents: update each with the argument you want. Agents are released on their own, so their versions differ from the dashboard's. A dashboard works with every agent whose [protocol](api.md#agent-protocol) it supports, and shows **agent incompatible** for the others. When a release changes the protocol, update the dashboard first. Switching a prerelease install back to stable can leave a newer data format behind; read the [prerelease notes](#prereleases) first.

## Backups

Stop the dashboard before copying its entire data directory so the SQLite database and any WAL files are consistent. Preserve file ownership and permissions. Also back up your YAML configuration and environment file; these may contain secrets.

- **Installer:** stop `llama-paddock` with `systemctl stop llama-paddock`, copy `/var/lib/llama-paddock` and `/etc/llama-paddock`, then run `systemctl start llama-paddock`.
- **Docker:** run `docker compose stop`, back up the `paddock-data` volume and your Compose/config/environment files, then run `docker compose start`. Compose normally prefixes the volume name with the project name; `docker volume ls` shows its actual name.
- **Source:** stop the Node.js process, copy `PADDOCK_DATA_DIR` and any configuration, then restart it.

To restore, stop the dashboard, restore the saved data and config with their original ownership and private permissions, then start the matching application version. Agent tokens/config live separately on each host; back up those files too if you need to rebuild a host.

## Prereleases

> [!WARNING]
> Prereleases are for testing. They contain releasable changes merged to `dev`, before those reach stable, so features may be unfinished and there may be bugs, including ones that lose metric history or settings. The data format can change between prereleases, so going back to stable may mean waiting for the next stable release.

To try the newest prerelease (`vX.Y.Z-dev.N`), use the prerelease installer. It works like the [stable installer](installation.md#proxmox-or-debianubuntu), with the same options, but shows this disclaimer and asks before installing:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/dev/install/dashboard-dev.sh)"
```

`update-llama-paddock` then stays on prereleases. To go back to stable, run `update-llama-paddock stable` inside the existing dashboard container or VM, after checking data compatibility. With Docker, select `:dev` for prereleases or `:latest` for stable, then pull and recreate the container.

## Uninstall

- **Inside the container or VM:** `uninstall-llama-paddock` removes the service and `/opt/llama-paddock`. It asks whether to also delete the config, saved hosts and login (`/etc/llama-paddock`, `/var/lib/llama-paddock`); keep them and a reinstall picks them up again. Unattended: `PADDOCK_YES=1`, plus `PADDOCK_PURGE=1` to delete the data too.
- **On the Proxmox host:** run the one-liner with `PADDOCK_UNINSTALL=1`. The dashboard has its own container, so this **destroys that container**. Only containers tagged `llama-paddock` (set by the installer) are offered, and you confirm by typing the CT ID. Unattended: `PADDOCK_UNINSTALL=1 PADDOCK_YES=1 CT_ID=<ctid>`.
- **Docker:** `docker compose down` removes the running deployment and keeps its named volume. Adding `-v` deletes that volume, including saved hosts, login and history.
- **Agents:** see the [Linux](agent-linux.md) and [Windows](agent-windows.md) guides. Removing an agent leaves Ollama and its settings in place.

## Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard cannot reach Ollama | Check the URL from the dashboard host/container, the host firewall and `OLLAMA_HOST`. In Docker, `localhost` refers to the dashboard container. |
| Models work but GPU stats, environment or logs do not | Check the agent URL and token, port 11435, and whether the agent is running. `/health` on the agent is unauthenticated; a successful health check does not verify the token. |
| Agent: "incompatible: it speaks protocol …" (**agent incompatible**) | The agent speaks an [agent protocol](api.md#agent-protocol) this dashboard doesn't support. The message says whether to update the dashboard or the agent. Until then, the dashboard doesn't call the agent. |
| Agent: "it doesn't answer HTTPS" | The agent is older than 0.7.0. Update it, or use `http://` in the agent URL until then. |
| Agent: "this agent only accepts HTTPS" | The agent runs with `PADDOCK_AGENT_HTTP=off`. Use **Switch to HTTPS** on the host's page, or `https://` in the agent URL. |
| "The agent's key has changed" | The agent presented a different key than the pinned one, and the dashboard stopped calling it. If you replaced the key or reinstalled the agent, compare the presented fingerprint with the installer's output and accept it. See [encrypted agent connections](security.md#encrypted-agent-connections). |
| Windows host disappears after signing out | Both the Ollama desktop app and agent logon task need the user's session. |
| No GPU process memory on Windows | Consumer GPUs in WDDM mode do not expose per-process VRAM through `nvidia-smi`, so the process table can be empty. |
| Models run on the CPU although `nvidia-smi` shows the GPU | See the **GPU check** on the host's Monitor tab and [its causes and fixes](gpu-check.md#causes-and-fixes). A suspend and resume, or a driver update without a reboot, are the usual reasons. |
| No AMD or Apple GPU cards | GPU collection currently uses `nvidia-smi`; AMD and Apple support are planned. |
| History disappears after restarting | Check write permissions and free space in the data directory. If SQLite cannot open, the dashboard logs a warning and falls back to in-memory history. |
| Password changed in `.env` but login is unchanged | Environment credentials apply only before `auth.json` exists. Follow [password recovery](configuration.md#login). |
| "your account is read-only" | The account is a viewer. An admin can change its role under **Users**. See [Users and roles](configuration.md#users-and-roles). |
| Proxmox console shows `^[[1;1R` at login | For containers created by older installers, run `pct set <ctid> --cmode console` on the Proxmox host. |

Dashboard logs: `journalctl -u llama-paddock` for systemd, or `docker compose logs llama-paddock` for Docker. Linux agent logs: `journalctl -u llama-paddock-agent`. On Windows, check Task Scheduler → `llama-paddock-agent`.

For unresolved problems, open an [issue](https://github.com/SplendidChip758/llama-paddock/issues) with the version, deployment method and relevant logs, removing tokens, passwords and private host details. Report vulnerabilities through the [security policy](../SECURITY.md).

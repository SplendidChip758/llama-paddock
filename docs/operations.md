# Updates, backups and troubleshooting

Keep llama-paddock up to date, back it up, try prereleases, remove it, and fix common problems.

## Updates

Take a [backup](#backups) before upgrading, especially when changing release channels.

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

`paddock-backup` takes a **full backup**: everything needed to put an install back exactly as it was. It holds a consistent snapshot of `paddock.db` (history, alerts, benchmarks, the audit log, jobs), the other files in the [data directory](configuration.md#data-directory) (hosts, users, API tokens, pinned agent keys, alert rules and channels), `config.yaml` and, for installer installs, the service's env file. Each backup records the application and database schema versions and a SHA-256 checksum for every file. Backups hold secrets: they're written with mode 600, in a directory only the dashboard's user can read.

A full backup is for putting the same install back, for example after an update that went wrong. To move the dashboard to another machine, use a [configuration export](#configuration-export) instead.

The dashboard can keep running while you take a backup: the database is read in a single transaction, so the copy is consistent. Uploads in progress (`uploads/`) aren't included.

| Installation | Back up | Restore |
|---|---|---|
| Dashboard installer | `paddock-backup backup` as root, in the container/VM (`pct exec <ctid> -- paddock-backup backup` from Proxmox) | `paddock-backup restore <name>`: it stops `llama-paddock`, puts the files back and starts it again |
| Docker Compose | `docker compose exec llama-paddock paddock-backup backup` | `docker compose stop`, then `docker compose run --rm llama-paddock paddock-backup restore <name>`, then `docker compose start` |
| Source | `node dashboard/bin/paddock-backup.mjs backup`, with the same `PADDOCK_DATA_DIR` and `PADDOCK_CONFIG` as the dashboard | Stop the dashboard, run `… restore <name>`, start it again |

Backups go to `backups/` in the data directory. For Docker, that's inside the `paddock-data` volume. To keep them off the machine, copy them elsewhere, or pass `--dir` to write them somewhere else. The commands:

| Command | Does |
|---|---|
| `paddock-backup backup` | Takes a full backup and prints its directory. `--reason pre-update` marks it as taken before an update: only the newest 5 of those are kept. Manual backups are kept until you delete them |
| `paddock-backup list` | Lists the backups, oldest first, with their date, reason and size |
| `paddock-backup verify <name>` | Checks every file against its checksum, and the database's integrity |
| `paddock-backup restore <name>` | Puts the install back as the backup has it. `--data-only` leaves `config.yaml` and the env file alone |

Every command takes `--dir DIR` (where backups live), `--env-file FILE` (back up and restore the service's env file; the installer's command sets it) and `--json` (output for scripts).

A restore:

- refuses while the dashboard is running on that data directory. Stop it first; the installer's command does this for you.
- refuses a damaged backup (a checksum doesn't match) before changing anything.
- refuses a backup from a newer version than the one installed, and says which version to install first. A backup from an older version restores, and its data is upgraded when the dashboard starts, as it would be by an update.
- first backs up the state it replaces (reason `pre-restore`, newest 3 kept), so a restore can be undone with another restore.
- removes data files that were added after the backup was taken, such as API tokens created since, so they don't survive the restore.
- leaves `config.yaml` alone when it's unchanged, so a read-only Docker mount isn't a problem. When it has changed and can't be written, the restore stops before changing anything: use `--data-only`.

`paddock-backup` comes with releases from 0.10.0. With older releases, stop the dashboard and copy the data directory, `config.yaml` and the env file by hand, keeping ownership and permissions. Agent tokens and settings live on each Ollama host: back those up there if you need to rebuild a host.

### Configuration export

A **configuration export** moves the dashboard's setup to another install: one small file with what you set up, without what the dashboard recorded. It's what you need to move to another machine, or from the installer to Docker. Unlike a full backup, it doesn't roll an install back.

| In the export | Not in the export |
|---|---|
| Hosts added in the dashboard, with their agent tokens, Ollama proxy keys and pinned agent keys | Metric history, events and alert history |
| Users, with their password hashes and roles | Jobs, benchmarks and the audit log |
| API tokens (as hashes: the tokens themselves keep working) | Silences |
| Alert rules and channels, with the channels' URLs, tokens and SMTP passwords | The session key: everyone signs in again |
| Request client names and dismissed security checks | The service's env file |
| `config.yaml` | Theme choices, which each browser keeps |

**Export** under **Backup** in the account menu (admins). The file is encrypted with a passphrase of at least 12 characters (scrypt and AES-256-GCM). Without the passphrase it can't be read or imported, and it can't be recovered. You can choose to export it unencrypted instead: the file then holds every agent token, key and password hash in plain text, so keep it where only you can read it and delete it once imported. Either way the export asks for your password, and it's recorded in the audit log.

**Import** it on the other install under **Backup**, or on a fresh install from the first sign-in screen, before you choose a password (**Moving from another dashboard?**). Choose the file, enter the passphrase and select what to import, then **Preview import**: it lists every host, user, token, rule and channel that would be added, replaced or skipped, and why. Nothing changes until you press **Import**. Then:

- nothing is removed. An entry is added, or replaced when this install has the same host ID, user name (whatever the case), token, rule or channel ID. An entry that is the same here is skipped.
- a replaced user gets the password from the export and is signed out, you too. After an import on a fresh install, sign in with your account from the other install.
- an API token is imported with its user. A token whose user isn't imported and doesn't exist here is skipped.
- a host whose ID `config.yaml` defines here is skipped: `config.yaml` comes first.
- hosts, rules and channels take effect at once, without a restart.
- the dashboard never writes `config.yaml`. When the export's is different, the preview says so; copy the settings by hand or import it with `paddock-backup import --config`, then restart the dashboard.

From the shell, `paddock-backup` does the same:

| Command | Does |
|---|---|
| `paddock-backup export <file>` | Writes the export to `<file>` (mode 600; `-` for standard output). It never overwrites a file. `--unencrypted` skips the passphrase |
| `paddock-backup import <file>` | Imports an export. `--dry-run` only lists what would happen; `--only hosts,users,…` limits it to some parts (`hosts`, `users`, `tokens`, `rules`, `channels`, `clients`, `dismissals`, `config`); `--config` also writes `config.yaml` when it differs |

The passphrase is asked for at the terminal, or read from `--passphrase-file FILE` (`-` for standard input) or `PADDOCK_PASSPHRASE`. `import` refuses while the dashboard runs, except with `--dry-run`: the installer's command stops and starts `llama-paddock` for you. Before an import changes anything, from the shell or the dashboard, it takes a full backup (reason `pre-import`, newest 3 kept), so `paddock-backup restore` undoes it. If that backup fails, the import doesn't run. With Docker, run it in a one-off container while the dashboard is stopped, as for a restore, with the file in a mounted directory.

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

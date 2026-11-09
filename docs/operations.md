# Updates, backups and troubleshooting

Keep llama-paddock up to date, back it up, try prereleases, remove it, and fix common problems.

## Updates

Take a [backup](#backups) before upgrading, especially when changing release channels.

| Installation | Update |
|---|---|
| Dashboard installer | Click **Update to …** on the dashboard's update page (see [Updating the dashboard](#updating-the-dashboard)), or run `update-llama-paddock` inside its container/VM, or `pct exec <ctid> -- update-llama-paddock` from Proxmox. It stays on the channel you installed from; see [Update channels](#update-channels) |
| Docker Compose | Take a backup, then run `docker compose pull` and `docker compose up -d` from the Compose directory; see [Docker updates](#docker-updates) |
| Linux agent | Run `update-llama-paddock-agent` on the Ollama host, or `pct exec <ctid> -- update-llama-paddock-agent` from Proxmox. It follows the same [update channels](#update-channels) as the dashboard updater |
| Windows agent | Extract `llama-paddock-agent-windows.zip` from the new [Windows agent release](https://github.com/SplendidChip758/llama-paddock-win-agent/releases) and re-run `install.ps1` from the same account; see [Windows updates](agent-windows.md#settings-and-updates) |
| Source | Update your checkout and repeat the [build steps](installation.md#from-source) |

Installer updates keep configuration and existing agent tokens, and take a full backup first. If the new release doesn't start, the installer puts the previous one and the backup back. Docker updates retain the data volume.

### Updating the dashboard

The dashboard looks for a newer release of itself every 6 hours, on its channel: stable releases, or prereleases too on the prerelease channel. When one is out, the version in the header shows **update**. Click it to open **Updates**, with the release notes of every release since yours and the way to update this install. **Check now** asks GitHub straight away. To stop the dashboard asking GitHub at all, set [`update_check: false`](configuration.md#dashboard-settings).

| Installation | From the dashboard |
|---|---|
| Dashboard installer | Admins click **Update to …**, switch the [channel](#channel-and-automatic-updates), turn on [automatic updates](#channel-and-automatic-updates) and [roll back](#rolling-back-an-update) an update. See [below](#installer-updates-from-the-dashboard) |
| Docker Compose | Shows the commands to run: a backup, then the image update. See [Docker updates](#docker-updates) |
| Source or anything else | Not supported: the page says so. Update it the way you installed it |

#### Installer updates from the dashboard

The dashboard runs as an unprivileged user and can't update itself. Instead it writes a request (`update-request.json`) into its data directory. The installer sets up `llama-paddock-update.path`, which starts `llama-paddock-updater` as root when the request appears. The updater takes nothing from the request but a release tag. It refuses a tag that isn't newer than the installed release, or a prerelease on a stable install. Then it runs `update-llama-paddock` with that tag, on the install's own channel. The update then goes the same way as one you start with `update-llama-paddock`:

1. It downloads the release and checks it against the release's `SHA256SUMS`. A file that doesn't match is never installed.
2. It stops the dashboard and takes a full [backup](#backups) with `paddock-backup` (reason `pre-update`). If the backup fails, it starts the old release again and changes nothing.
3. It installs the new release, keeping the old one next to it, and starts the dashboard.
4. It waits up to 2 minutes for `/api/healthz` to answer with the new version. If it does, the old release is removed. If not, the updater stops the dashboard, puts the old release back, restores the backup and starts it again. The update page then says the update failed and the previous version is back, with the updater's output.

While it runs, the dashboard restarts and the update page reconnects on its own. An update that was interrupted (a crash, a reboot, a killed updater) is rolled back the same way: by `llama-paddock-recover.service` before the dashboard starts at boot, or the next time the updater or the installer runs.

The updater writes its status and output to `/var/lib/llama-paddock-update/` (`status.json`, `update.log`); `journalctl -u llama-paddock-update` has the rest. Installs from before 0.10.0 get the updater the next time `update-llama-paddock` runs. Starting an update is logged in the [audit log](security.md#audit-log) as `dashboard.update`.

**Update history** lists every update, rollback and channel switch: from the dashboard, from `update-llama-paddock` in a terminal, and automatic ones. The updater keeps it in `history.jsonl` in the same directory.

#### Channel and automatic updates

The top of **Updates** has the install's channel and the automatic updates switch:

- **Channel:** **Stable** or **Prerelease**, the same as `update-llama-paddock stable` or `dev`. Switching to prereleases installs the newest prerelease straight away, with the same backup and rollback. Switching back to stable never installs an older release: a newer prerelease stays until a stable release newer than it is out, because the data format can't go backwards. Both ask first.
- **Automatic updates:** off by default, and for the stable channel only (the switch is greyed out on prereleases). When it is on, `llama-paddock-auto-update.timer` looks for a newer stable release every 6 hours and installs it the same way as **Update to …**, with the backup, the health check and the rollback. Runs that find nothing new aren't recorded. Logged as `dashboard.auto_update`.

#### Rolling back an update

**Roll back to …** in the history puts an update back: the version from before it, and its data as it was then, from the update's pre-update backup. It's offered while that backup is kept (the newest 5 pre-update backups are) and only for versions older than the running one. Everything since the update is lost: metric history, alerts and benchmarks recorded since, and users, tokens or hosts added since. The dashboard asks first, and the state it replaces is backed up too (a `pre-update` backup), so a rollback can be rolled back.

The updater checks that the backup is a real pre-update backup from that version before it does anything. It installs that release with `PADDOCK_RESTORE_BACKUP`, restores the backup and starts the dashboard, with the same health check: if the older version doesn't start, the newer one and its data come back. Logged as `dashboard.rollback`.

#### Docker updates

The dashboard can't replace its own image. Run these next to your `docker-compose.yml`:

```bash
docker compose exec llama-paddock paddock-backup backup --reason pre-update
docker compose pull
docker compose up -d
```

The first command prints the backup's name. If the new version doesn't work, roll back:

1. Pin the previous version in `docker-compose.yml`, for example `image: ghcr.io/splendidchip758/llama-paddock:0.10.0`. Every release is published under its version.
2. `docker compose stop`
3. `docker compose run --rm llama-paddock paddock-backup restore <name>`
4. `docker compose up -d`

Restore with the version the backup was taken with, or a newer one: `paddock-backup` refuses a backup from a newer version than the image. CI runs these steps on every pull request, from the published image to the one built from the change.

### Update channels

`update-llama-paddock` (dashboard) and `update-llama-paddock-agent` (Linux agent) take the same optional argument:

| Command | Installs |
|---|---|
| `update-llama-paddock` | The newest release on the channel this install already follows |
| `update-llama-paddock stable` | The newest stable release, and switches the install to the stable channel |
| `update-llama-paddock dev` | The newest release including [prereleases](#prereleases), and switches the install to the prerelease channel |
| `update-llama-paddock v0.8.0` | That exact release. A prerelease tag (`v0.9.0-dev.3`) puts the install on the prerelease channel, a stable tag on the stable channel |

`update-llama-paddock` checks the release against its `SHA256SUMS` before installing it, takes a backup and rolls back when the new version doesn't come up, as described in [Installer updates from the dashboard](#installer-updates-from-the-dashboard). If the install is already on the release the command would fetch, the updater says so and stops: nothing is downloaded, and the dashboard or agent isn't restarted. It still goes ahead when the service isn't running, to bring it back. To reinstall the same release anyway (to repair an install, say), set `PADDOCK_FORCE=1`: `PADDOCK_FORCE=1 update-llama-paddock`.

An install follows the channel it was installed or last switched to, so a prerelease install keeps getting prereleases and a stable one keeps getting stable releases. The channel is not shared between the dashboard and its agents: update each with the argument you want. Agents are released on their own, so their versions differ from the dashboard's. A dashboard works with every agent whose [protocol](api.md#agent-protocol) it supports, and shows **agent incompatible** for the others. When a release changes the protocol, update the dashboard first. Switching a prerelease install back to stable can leave a newer data format behind; read the [prerelease notes](#prereleases) first.

## Backups

`paddock-backup` takes a **full backup**: everything needed to put an install back exactly as it was. It holds a consistent snapshot of `paddock.db` (history, alerts, benchmarks, the audit log, jobs), the other files in the [data directory](configuration.md#data-directory) (hosts, users, API tokens, pinned agent keys, alert rules and channels), `config.yaml` and, for installer installs, the service's env file. Each backup records the application and database schema versions and a SHA-256 checksum for every file. Backups hold secrets: they're written with mode 600, in a directory only the dashboard's user can read.

A full backup is for putting the same install back, for example after an update that went wrong. It isn't a way to move the dashboard to another machine.

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

# Install the dashboard

The one-line installer is the recommended way. You can also run the dashboard with [Docker](docker.md) or [from source](from-source.md), or try a [prerelease](prereleases.md).

Run this **on the Proxmox host** to create a dedicated LXC, or **inside any Debian/Ubuntu LXC or VM** to install there:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"
```

**On a Proxmox host** it opens a menu (whiptail dialogs, or plain text prompts without a terminal):

- **Default** shows a summary (Ubuntu LTS, next free CT ID, 2 cores, 1 GiB RAM, 6 GiB disk, DHCP on `vmbr0`, no root password) and creates the container when you choose **Create**.
- **Advanced** asks for every setting, then shows the same summary. **Change** goes back through the settings.
  - distribution: latest **Ubuntu LTS** or **Debian**,
  - CT ID, hostname, cores, RAM and disk,
  - storage and bridge, picked from what the node has,
  - VLAN tag, DHCP or a static IP (the gateway defaults to the first address of the subnet),
  - root password (blank means none, use `pct enter <ctid>` from the host),
  - root SSH login: `key` (default, key only), `password`, or `off`, plus an optional SSH public key file.

Every setting can be preset in the environment (`CT_OS`, `CT_ID`, `CT_HOSTNAME`, `CT_CORES`, `CT_RAM`, `CT_DISK`, `CT_STORAGE`, `CT_TSTORAGE`, `CT_BRIDGE`, `CT_VLAN`, `CT_IP`, `CT_GW`, `CT_PASSWORD`, `CT_ROOT_SSH`, `CT_SSH_KEY`). Add `PADDOCK_YES=1` to skip the menu entirely, or `PADDOCK_TUI=0` for text prompts instead of dialogs.

It then downloads the latest template for the distribution you pick (latest **Ubuntu LTS** by default, or **Debian**), creates an unprivileged container, and installs the dashboard inside it.

The container's **Notes** in the Proxmox UI get links to the dashboard (when it has a static IP), releases and issues. Logging in to the container shows a short banner with its version, OS, hostname, dashboard URL and status. Delete `/etc/profile.d/00_llama-paddock.sh` to turn the banner off.

The container's console mode is `/dev/console`. In the default `tty` mode, newer distributions (util-linux 2.40.3+) show escape codes like `^[[1;1R` in the console's login prompt. For a container created by an older installer, run `pct set <ctid> --cmode console` on the host.

**Inside a container or VM** it:
- installs Node.js 22 if needed,
- downloads the prebuilt dashboard from the latest GitHub release, or builds from `main` if there's no release yet,
- installs it to `/opt/llama-paddock` as the `llama-paddock` systemd service, running as an unprivileged user,
- writes `/etc/llama-paddock/config.yaml` and `/etc/llama-paddock/llama-paddock.env`, including a generated initial `admin` password,
- prints the URL and login.

Open the URL, sign in with the printed password, and choose your own password (required on first sign-in). Then use **Add host** to add your Ollama servers. Hosts added in the UI and the login are stored in `/var/lib/llama-paddock`.

Update with `update-llama-paddock` inside the container, or `pct exec <ctid> -- update-llama-paddock` from the host. Your config is kept.

## Uninstall

- **Inside the container or VM:** `uninstall-llama-paddock` removes the service and `/opt/llama-paddock`. It asks whether to also delete the config, saved hosts and login (`/etc/llama-paddock`, `/var/lib/llama-paddock`); keep them and a reinstall picks them up again. Unattended: `PADDOCK_YES=1`, plus `PADDOCK_PURGE=1` to delete the data too.
- **On the Proxmox host:** run the one-liner with `PADDOCK_UNINSTALL=1`. The dashboard has its own container, so this **destroys that container**. Only containers tagged `llama-paddock` (set by the installer) are offered, and you confirm by typing the CT ID. Unattended: `PADDOCK_UNINSTALL=1 PADDOCK_YES=1 CT_ID=<ctid>`.

## Options

| Option | Default | |
|---|---|---|
| `PADDOCK_VERSION` | `latest` | a release tag (`v1.2.0`), or `source` to build `main` |
| `PADDOCK_PORT` | `8080` | |
| `PADDOCK_LOCAL=1` | | install on the Proxmox host itself instead of creating a CT |
| `PADDOCK_YES=1` | | non-interactive, accept defaults |

Example: `PADDOCK_VERSION=v0.1.0 bash -c "$(curl -fsSL …/install/dashboard.sh)"`.

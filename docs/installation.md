# Install the dashboard

Install the dashboard on a Proxmox host, in a Debian/Ubuntu LXC or VM, with Docker or from source, then add your Ollama hosts.

## Proxmox or Debian/Ubuntu

Run as root **on the Proxmox host** to create a dedicated LXC, or **inside any Debian/Ubuntu LXC or VM** to install there:

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

See [Updates and backups](operations.md) before upgrading or switching channels.

### Installer options

| Option | Default | Purpose |
|---|---|---|
| `PADDOCK_VERSION` | `latest` | a release tag (`v1.2.0`), `dev` for the newest release including [prereleases](operations.md#prereleases), or `source` to build `PADDOCK_BRANCH` (default: `main`) |
| `PADDOCK_PORT` | `8080` | Dashboard listen port |
| `PADDOCK_LOCAL=1` | | install on the Proxmox host itself instead of creating a CT |
| `PADDOCK_YES=1` | | non-interactive, accept defaults |

For prereleases and uninstall instructions, see [Operations](operations.md).

## Docker

The published image supports amd64 and arm64. Get the Compose file and example environment from this repository:

```bash
git clone https://github.com/SplendidChip758/llama-paddock.git
cd llama-paddock
cp .env.example .env
```

Edit `.env` to set an initial password, or leave `PADDOCK_PASSWORD` empty to generate one and print it in the container logs. Then start the dashboard:

```bash
docker compose up -d
```

Sign in at `http://<docker-host>:8080`, choose a new password, then **Add host**. Hosts, the login, metric history and job state are kept in the `paddock-data` volume (`/data`).

For the latest prerelease, change the image tag in `docker-compose.yml` to `:dev`; read the [prerelease notes](operations.md#prereleases) first. To build locally, replace `image:` with `build: ./dashboard`. In an unprivileged LXC, Docker needs `nesting=1,keyctl=1`.

For declarative hosts and polling settings, see [Configuration](configuration.md).

## From source

Requires Node.js 22.13 or newer for the built-in `node:sqlite`. From a clone of this repository:

```bash
cd dashboard
npm ci
npm run build
cp -r .next/static .next/standalone/.next/static
PADDOCK_DATA_DIR="$PWD/../data" HOSTNAME=0.0.0.0 PORT=8080 node .next/standalone/server.js
```

Use an absolute data path: the standalone server changes its working directory. Open `http://<dashboard-host>:8080` and use the initial password printed in the terminal. For a development server, see [Contributing](../CONTRIBUTING.md#local-development).

## Add your Ollama hosts

In **Add host**, enter a name and an Ollama URL such as `http://192.168.30.101:11434`. Add the agent URL (`http://192.168.30.101:11435`) and its token for GPU/host stats, environment editing, restarts and logs. Ollama has no keys of its own; if a proxy in front of it checks one ([setup examples](proxy.md#ollama-behind-a-proxy)), enter it under **Proxy key**. It's sent as `Authorization: Bearer <key>`, and leaving it blank when editing keeps the stored one. The connection test checks the Ollama and agent endpoints separately, and says when the proxy wants a key or rejects the one given.

An agent is optional for model management. Follow the [Linux](agent-linux.md) or [Windows](agent-windows.md) guide to install one. Both endpoints must be reachable from the dashboard host; `localhost` in a Docker deployment refers to the dashboard container.

Keep Ollama and the agent on a trusted network and limit access to the dashboard host. The dashboard login does not protect direct access to those services.

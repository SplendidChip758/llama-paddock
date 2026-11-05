# Configuration and login

Most installations can add hosts directly in the dashboard. Use `config.yaml` for polling/history settings or hosts managed as configuration.

## Dashboard settings

Copy [`config.example.yaml`](../config.example.yaml) to `config.yaml`. With Docker, uncomment its read-only mount in [`docker-compose.yml`](../docker-compose.yml). The installer uses `/etc/llama-paddock/config.yaml`. Restart the dashboard after editing the file.

| YAML setting | Default | Meaning |
|---|---|---|
| `poll_interval` | `3` | Seconds between polls of each instance |
| `history_points` | `400` | Recent samples returned for sparklines (about 20 minutes at 3 seconds) |
| `history_retention_days` | `30` | Days of metric history, host events and alert transitions to retain; must be positive |
| `metrics_token` | unset | Bearer token for the Prometheus [`/metrics`](prometheus.md) endpoint; falls back to `PADDOCK_METRICS_TOKEN`. Without a token or `metrics_open`, `/metrics` is off |
| `metrics_open` | `false` | `true` serves `/metrics` without a token; ignored when a token is set |
| `instances` | `[]` | Declarative hosts; read-only in the UI |

Raw polls are kept for up to 24 hours, one-minute averages for up to 7 days, and 15-minute averages up to the retention limit. Reducing retention also shortens the finer tiers. See the [history API](api.md#history) for the resolution returned by each range.

## Declarative hosts

```yaml
instances:
  - id: ollama-01
    name: Ollama host
    ollama_url: http://192.168.30.101:11434
    agent_url: https://192.168.30.101:11435
    agent_token: ${OLLAMA01_AGENT_TOKEN}
    agent_fingerprint: "SHA256:5dVNl4le02RH/xY8StjVGPXLxf+8Q01votZq+IdxBJA"
    tags: [linux, gpu]
```

Only `ollama_url` is required; supply a stable, unique `id` using letters, digits, `_`, `.` or `-`. `name` defaults to the ID. Omit `agent_url` and `agent_token` for a host without an agent. For an `https://` agent URL, `agent_fingerprint` is the key the agent installer printed: the dashboard only talks to an agent with that key. Without it, the dashboard pins the key the agent presents on the first connection and keeps it in `agent-pins.json` in the data directory; see [encrypted agent connections](security.md#encrypted-agent-connections). Ollama has no keys of its own. If a proxy in front of it checks one, add `ollama_proxy_key: ${OLLAMA01_PROXY_KEY}`: the dashboard sends it as `Authorization: Bearer <key>` on every Ollama call. See [Ollama behind a proxy](proxy.md#ollama-behind-a-proxy) for proxy setups. Config-defined hosts take precedence over UI hosts with the same ID.

`${VAR}` and `${VAR:-default}` expand from the dashboard process environment; the default is used when the variable is unset. Docker Compose passes values through `.env` using `env_file`. For a systemd install, put them in `/etc/llama-paddock/llama-paddock.env`. A source launch does not automatically read the repository's `.env`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PADDOCK_CONFIG` | `/config/config.yaml` | Optional YAML file |
| `PADDOCK_DATA_DIR` | `data` beside the config file | Writable persistent data directory; prefer an absolute path |
| `PADDOCK_USERNAME` | `admin` | Name of the first admin account |
| `PADDOCK_PASSWORD` | generated when empty | Initial password of the first admin |
| `PADDOCK_AUTH` | login enabled | Set to `off` only when access is protected elsewhere |
| `PADDOCK_METRICS_TOKEN` | unset | Scrape token for [`/metrics`](prometheus.md), used when `metrics_token` isn't set in `config.yaml` |
| `PADDOCK_TRUSTED_PROXIES` | `0` | Number of reverse proxies in front of the dashboard, so the login lockout can tell clients apart. See [Reverse proxies](proxy.md#the-dashboard-behind-a-proxy) |
| `PORT` | `8080` in packaged installs | Dashboard listen port; the installer sets it through `PADDOCK_PORT` |
| `HOSTNAME` | `0.0.0.0` in packaged installs | Standalone server bind address |

## Login

- `PADDOCK_USERNAME` / `PADDOCK_PASSWORD` set the **first admin** account. The first sign-in requires choosing a new password, which is stored hashed (scrypt) in `auth.json` in the data directory. After that the env values are ignored.
- If `PADDOCK_PASSWORD` is empty, a random one is printed to the log on first start.
- Change your password from the account menu (top right). Changing it signs out your other sessions.
- Five wrong attempts lock that address out for 5 minutes, and 20 wrong attempts from all addresses together pause the login for everyone for 5 minutes. Behind a reverse proxy, set `PADDOCK_TRUSTED_PROXIES` so the per-address lockout sees the real client. See [Security](security.md).
- **Forgot a password:** another admin can reset it under **Users**. If no admin can sign in, stop the dashboard, delete `auth.json` from the data directory (`/var/lib/llama-paddock`, or the Docker volume) and restart. This removes **every** account and every API token; the first admin is recreated from the env values.
- `PADDOCK_AUTH=off` disables the login, e.g. when a reverse proxy with auth already sits in front of it. Everyone the proxy lets in then has full control, and there are no roles. `/api/healthz` stays open for health checks.

### Users and roles

Each person can have their own account, with one of two roles:

| Role | Can |
|---|---|
| **admin** | Everything: add and edit hosts, pull and delete models, edit Ollama's environment, restart it, manage alerts and users |
| **viewer** | See everything an admin sees, but change nothing. The buttons that change something are hidden, and the server refuses those requests with 403 |

Admins manage accounts under **Users** in the account menu:

- **Add user:** pick a name and a role. The dashboard makes a temporary password, shown once, for you to pass on. The new user must choose their own when they first sign in.
- **Role:** takes effect at once, also for a user who is signed in. Making an admin a viewer also takes write access from their API tokens, for good.
- **Reset password:** signs the user out everywhere and shows a new temporary password. Their API tokens keep working; revoke them under **API tokens** if needed.
- **Remove:** signs the user out at once and removes their API tokens.

Every user can create [API tokens](api.md#api-tokens) for scripts under **API tokens** in the account menu: read-only, or read and write for admins. Admins can also list and revoke everyone's.

An admin can't change the role of, reset or remove their own account, so there is always an admin who can sign in. Usernames are matched without regard to case.

Dashboards from before user accounts had a single login. On upgrade it becomes the first admin, with the same name and password. Whoever was signed in signs in once more.

## Data directory

| Install | Data location |
|---|---|
| One-line installer | `/var/lib/llama-paddock` |
| Docker Compose | `paddock-data` volume, mounted at `/data` |
| Source | The path set by `PADDOCK_DATA_DIR` |

`hosts.json` stores hosts added in the UI, including agent tokens, proxy keys and pinned agent keys. `agent-pins.json` stores the agent keys pinned for `config.yaml` hosts without an `agent_fingerprint`. `auth.json` stores the user accounts, their password hashes and roles, and the session signing secret. `credentials.json` stores the [API tokens](api.md#api-tokens): their names, owners, scopes, expiry and hashes, never the tokens themselves. `alert-rules.json` stores the [alert rules](alerts.md) once they have been changed in the dashboard, and `alert-channels.json` the [notification channels](alerts.md#notifications), including their webhook URLs and passwords. `request-clients.json` stores the names given to client addresses in the [request log](usage.md#requests). `paddock.db` stores metric history, host availability and model load events, alerts firing and resolving, alert silences, the request log, and jobs; SQLite may also create `paddock.db-wal` and `paddock.db-shm`.

Keep these files private (mode 600 on Linux) and retain the directory across upgrades. See [Backups](operations.md#backups) for copying SQLite data safely. Agent configuration is separate: [Linux](agent-linux.md) and [Windows](agent-windows.md#settings-and-updates).

# API reference

The dashboard exposes the JSON endpoints used by its UI. Paths below are relative to the dashboard URL, for example `http://192.168.30.100:8080`. These APIs are pre-1.0 and may change; use the documentation matching your installed version.

## Authentication

Dashboard requests use a session cookie, not the agent bearer token. Send JSON bodies with `Content-Type: application/json`; other content types are refused with 415.

1. `POST /api/auth/login` with `{"username":"admin","password":"…"}`. Save the returned `paddock_session` cookie and send it on subsequent requests.
2. If the response has `must_change: true`, call `POST /api/auth/password` with `{"password":"…"}` and save the replacement cookie. Other application endpoints return 403 until this is done. The new password must differ from the old one and contain at least eight characters.
3. Sessions last seven days. Changing the password invalidates other sessions.
4. Failed logins return 401. After five failures from one address, or 20 from all addresses together, the login returns 429 for five minutes. See [Security](security.md).
5. From a browser, requests other than `GET` must come from the dashboard's own origin, or they get 403. `curl` and scripts send no `Origin` or `Sec-Fetch-Site` header and are unaffected. See [Cross-site requests](security.md#cross-site-requests).

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{ok, must_change}` and a session cookie |
| GET | `/api/auth/me` | `{auth, username, must_change, min_password}` when auth is enabled; `{auth: false}` otherwise |
| POST | `/api/auth/password` | `{current, password}`; `current` is optional during the forced first-login change |
| POST | `/api/auth/logout` | Clears the session cookie |
| GET | `/api/healthz` | `{ok, version}`; no login required |
| GET | `/metrics` | Prometheus metrics; needs the scrape token instead of a login, and is off unless configured. See [Prometheus](prometheus.md) |

`PADDOCK_AUTH=off` disables dashboard authentication. Only use it when another layer protects access. See [Login](configuration.md#login). Unauthenticated API requests normally return 401, and failed requests use a JSON `detail` field.

## Hosts

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances` | `{poll_interval, instances}` with latest status, stats, loaded models, the Ollama `version` and the `agent_version` (`null` if unknown) |
| GET | `/api/instances/{id}/history` | Recent samples or a requested range; see [History](#history) |
| GET | `/api/instances/{id}/events` | Availability and model load events over a range; see [Events](#events) |
| POST | `/api/instances` | Host fields below → `{id}` (201) |
| PUT | `/api/instances/{id}` | Host fields below → `{id}` |
| DELETE | `/api/instances/{id}` | Removes a UI-defined host and its stored metric history and events |
| POST | `/api/test-connection` | Host fields plus optional existing `id` → separate `ollama` and `agent` results |

Host fields are `name`, `ollama_url`, `ollama_proxy_key`, `agent_url`, `agent_token` and `tags`. `ollama_url` is required. `tags` accepts an array or comma-separated string. Use the ID returned by creation or listed in `/api/instances` in later requests.

Updates replace host fields, so send all values you want to retain. A blank or omitted `agent_token` keeps the stored token when an agent URL is supplied; clearing the agent URL removes its token. Likewise a blank or omitted `ollama_proxy_key` keeps the stored key; send `clear_ollama_proxy_key: true` to remove it. The 0.7.0 prereleases called it `ollama_api_key`, which is still accepted. Neither secret is ever returned: `/api/instances` reports `has_token` and `has_ollama_proxy_key` instead. Changing either endpoint or the token clears that host's metric history and events; changing only the proxy key keeps them. Config-defined hosts cannot be updated or removed through the API (409); edit the YAML instead.

## History

`GET /api/instances/{id}/history` returns `{resolution: 0, points}` with up to `history_points` recent raw polls.

Add `?range=…` for `{range, resolution, points}` over a longer interval:

| Range | Resolution (seconds) |
|---|---|
| `1h` | `0` (raw polls) |
| `6h` | `60` |
| `24h` | `60` |
| `7d` | `900` |
| `30d` | `900` |

Available points depend on how long the dashboard has collected data and the [retention setting](configuration.md#dashboard-settings). An unsupported range returns 400.

## Events

`GET /api/instances/{id}/events?range=…` returns what the poller saw change on a host: Ollama and the agent becoming reachable or unreachable, and models appearing in or leaving Ollama's `/api/ps`. The ranges are the same as for [History](#history); the default is `24h`.

```json
{
  "range": "24h", "from": 1793240000.1, "to": 1793326400.1,
  "coverage": 0.98,
  "observed": [{ "start": 1793240000.1, "end": 1793300000.4 }, { "start": 1793302000.2, "end": 1793326400.1 }],
  "ollama": { "up": 84000, "down": 600, "unknown": 0 },
  "agent": { "up": 84600, "down": 0, "unknown": 0 },
  "initial": { "ollama": true, "agent": true, "models": [] },
  "events": [
    { "instance": "gpu-box", "t": 1793250000.3, "kind": "load", "first": false, "model": "qwen3:8b", "digest": "…", "context_length": 8192, "size_vram": 6100000000 },
    { "instance": "gpu-box", "t": 1793260000.7, "kind": "ollama", "first": false, "up": false, "error": "ollama unreachable: ECONNREFUSED: …" }
  ]
}
```

| Field | Meaning |
|---|---|
| `observed` | Spans in which the dashboard was polling the host, clipped to the range. Time outside them, such as while the dashboard was stopped or polling paused for more than `3 × poll_interval + 30` seconds, is unknown: neither up nor down |
| `coverage` | Share of the range covered by `observed` |
| `ollama`, `agent` | Seconds of observed time in which each was reachable (`up`), unreachable (`down`) or not yet seen (`unknown`). `agent` is `null` for a host without an agent |
| `initial` | The state at `from`, or `null` when `from` falls outside an observed span |
| `events` | Changes in time order. `kind` is `ollama` or `agent` (with `up`, and `error` when down) or `load` or `unload` (with `model`, `digest`, `context_length` and `size_vram`) |

Events are observations, not exact usage. `t` is the poll in which a change was first seen, so it happened since the previous poll, and a model that was loaded and unloaded between two polls leaves no event. `first: true` marks the first observation after a time in which the state was unknown: after a dashboard restart or a gap in polling, and for models once Ollama is reachable again. That state began at or before `t`. While Ollama is unreachable, its loaded models are unknown, so there are no unload events for them. A model whose digest or context changes is recorded as an unload and a load, because Ollama loaded it again.

Events follow `history_retention_days`. When an observed span is older than the retention, the state at the cutoff is kept as `first` events, so a long span still starts with a known state.

## Models and jobs

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances/{id}/models` | Installed models from Ollama |
| POST | `/api/instances/{id}/models/show` | `{model}` → details, parsed parameters, system prompt and native context length |
| POST | `/api/instances/{id}/models/pull` | `{model}` → background job |
| POST | `/api/instances/{id}/models/create` | `{model, from, parameters?, system?}` → background job |
| POST | `/api/instances/{id}/models/load` | `{model, keep_alive?}` |
| POST | `/api/instances/{id}/models/unload` | `{model}` |
| POST | `/api/instances/{id}/models/delete` | `{model}` |
| POST | `/api/instances/{id}/models/copy` | `{source, destination}` |
| GET | `/api/jobs` | `{jobs}` containing job status and progress |
| DELETE | `/api/jobs/{jid}` | Cancels a running job, or removes a finished job from the list |

There is no `GET /api/jobs/{jid}`; find the returned job ID in `/api/jobs`. Pull and create responses are job objects, not streamed progress. Poll the jobs endpoint for updates. Pulls can resume after a dashboard restart; running creates are marked interrupted. See [History and jobs](usage.md#history-and-jobs).

## Environment, restart and logs

These routes require an agent configured for the host.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances/{id}/env` | Editable and inherited environment variables, and `allowed`: the names the agent lets you set (a trailing `*` allows a prefix) |
| PUT | `/api/instances/{id}/env` | `{vars, restart?}`; replaces managed variables on the allowlist, removing omitted ones. Restarts Ollama unless `restart` is `false`. A name outside `allowed` is refused with 400 unless its value is unchanged; names outside the list are kept as they are |
| POST | `/api/instances/{id}/restart` | Restarts Ollama |
| GET | `/api/instances/{id}/logs?lines=500` | Log tail; default 200 lines, clamped to 10–2000 |

Environment edits affect the managed systemd drop-in on Linux and the user's Ollama-related variables on Windows. See [Environment](usage.md#environment) before automating changes.

### Preserve existing environment settings

`vars` is a replacement, not a partial update. Both agents remove existing managed variables on the allowlist when you omit them. For example, sending only `OLLAMA_NUM_PARALLEL` can remove `OLLAMA_HOST` and `OLLAMA_MODELS`, changing network access or the model directory after a restart. Variables outside the allowlist and settings inherited from elsewhere are preserved.

Read the current `managed` map, modify that map, and send the complete result back. This Bash example requires `curl`, `jq` and a valid session in `cookies.txt` from [authentication](#authentication), including the first-login password change:

```bash
(
  set -eu
  umask 077
  dashboard_url=http://192.168.30.100:8080
  instance_id=ollama-01 # use the ID returned by /api/instances
  env_state=$(mktemp)
  env_body=$(mktemp)
  trap 'rm -f "$env_state" "$env_body"' EXIT

  curl --fail --silent --show-error -b cookies.txt \
    "$dashboard_url/api/instances/$instance_id/env" -o "$env_state"
  jq '.managed + {"OLLAMA_NUM_PARALLEL": "2"} | {vars: ., restart: false}' \
    "$env_state" > "$env_body"
  curl --fail --silent --show-error -b cookies.txt \
    -X PUT -H 'Content-Type: application/json' --data-binary "@$env_body" \
    "$dashboard_url/api/instances/$instance_id/env" -o /dev/null
)
```

This saves the settings without restarting Ollama. Verify them in the Environment tab, then use **Restart Ollama** when ready to apply them. Avoid concurrent environment edits while reading and writing: this sequence does not detect another user's changes. To intentionally remove a managed variable on the allowlist, omit it from the full map.

## Agent API

The agent listens separately, normally on port 11435. All endpoints except `/health` require `Authorization: Bearer <agent-token>`. The dashboard sends this header using the token stored for the host.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Agent version, platform and hostname; unauthenticated |
| GET | `/stats` | Agent version, platform, host, NVIDIA GPU and Ollama process stats |
| GET | `/env` | Environment state, including the `allowed` names (agents from 0.6.0) |
| PUT | `/env` | `{vars, restart?}`; replace managed variables on the allowlist, removing omitted ones; preserve variables outside the list. Restarts unless `restart` is `false`. See [preserving settings](#preserve-existing-environment-settings) |
| POST | `/service/restart` | Restart Ollama |
| GET | `/logs?lines=500` | Ollama log tail |

Both agents implement these routes. Installation and configuration: [Linux](agent-linux.md) · [Windows](agent-windows.md).

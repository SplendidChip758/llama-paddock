# API reference

The dashboard exposes the JSON endpoints used by its UI. Paths below are relative to the dashboard URL, for example `http://192.168.30.100:8080`. These APIs are pre-1.0 and may change; use the documentation matching your installed version.

## Authentication

The browser uses a session cookie. Scripts, Home Assistant and cron jobs use an [API token](#api-tokens) instead. Neither is the agent's bearer token. Send JSON bodies with `Content-Type: application/json`; other content types are refused with 415.

1. `POST /api/auth/login` with `{"username":"admin","password":"…"}`. Save the returned `paddock_session` cookie and send it on subsequent requests.
2. If the response has `must_change: true`, call `POST /api/auth/password` with `{"password":"…"}` and save the replacement cookie. Other application endpoints return 403 until this is done. The new password must differ from the old one and contain at least eight characters.
3. Sessions last seven days. Changing the password invalidates other sessions, and so do an admin resetting it or removing the account.
4. Failed logins return 401. After five failures from one address, or 20 from all addresses together, the login returns 429 for five minutes. See [Security](security.md).
5. Accounts have a [role](configuration.md#users-and-roles). A **viewer** may call every `GET` endpoint below except `/api/users` and `/api/audit`, plus `POST /api/instances/{id}/models/show`, `POST /api/instances/{id}/models/fit`, `POST /api/instances/{id}/gpu-check` and its own `/api/auth` routes. Anything else answers 403 with `code: "forbidden"`. An **admin** may call everything.
6. From a browser, requests other than `GET` must come from the dashboard's own origin, or they get 403. `curl` and scripts send no `Origin` or `Sec-Fetch-Site` header and are unaffected. See [Cross-site requests](security.md#cross-site-requests).

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{ok, must_change}` and a session cookie |
| GET | `/api/auth/me` | `{auth, username, role, must_change, min_password}` when auth is enabled; `{auth: false, role: "admin"}` otherwise. With a token, `{auth, username, role, must_change, token: {id, kind, name, scopes}}`, where `scopes` is what the token may do now |
| POST | `/api/auth/password` | `{current, password}`; `current` is optional during the forced first-login change |
| POST | `/api/auth/logout` | Clears the session cookie |
| GET | `/api/healthz` | `{ok, version, agent_protocol: {min, max}}`: the dashboard's version and the [agent protocols](#agent-protocol) it supports; no login required |
| GET | `/metrics` | Prometheus metrics; needs the scrape token instead of a login, and is off unless configured. See [Prometheus](prometheus.md) |

`PADDOCK_AUTH=off` disables dashboard authentication, and every request has admin rights. Only use it when another layer protects access. See [Login](configuration.md#login). Unauthenticated API requests normally return 401, and failed requests use a JSON `detail` field.

### API tokens

Create a token under **API tokens** in the account menu, and send it on every request:

```bash
curl -H "Authorization: Bearer paddock_…" http://192.168.30.100:8080/api/instances
```

- A token belongs to a user and has **scopes**. `api:read` allows every `GET` endpoint and the `POST` requests that only read (those a viewer may make); `api:write` allows the rest. Viewers can only create `api:read` tokens.
- A token never does more than its user's role allows at the time of the request. When an admin is made a viewer, their tokens lose `api:write` for good: making them an admin again doesn't restore it. Removing a user removes their tokens.
- Tokens can't manage users, tokens or passwords (`/api/users`, `/api/tokens`, `/api/auth/*` except `GET /api/auth/me`): those need a signed-in browser, so a leaked token can't create another or lock its owner out. They answer 403 with `code: "session_only"`.
- A missing scope answers 403 with `code: "forbidden"` and the `scope` that was needed. An unknown, revoked or expired token answers 401 with `code: "bad_token"`.
- Five unknown or wrong tokens from one address lock that address out of token requests for five minutes (429 with `Retry-After`). This is counted apart from failed logins, and an expired token doesn't count. See [Security](security.md#api-tokens).
- With a token, the `Authorization` header decides: a session cookie sent alongside is ignored. With `PADDOCK_AUTH=off` there are no tokens and the header is ignored.
- Tokens are shown once and stored as a SHA-256 hash. They look like `paddock_<16 hex>_<43 characters>`, so secret scanners and log filters can spot them.

A [Home Assistant RESTful sensor](https://www.home-assistant.io/integrations/sensor.rest/) that counts the hosts whose Ollama answers, with a read-only token kept in `secrets.yaml`:

```yaml
# configuration.yaml
sensor:
  - platform: rest
    name: Ollama hosts up
    resource: http://192.168.30.100:8080/api/instances
    headers:
      Authorization: !secret paddock_token   # secrets.yaml: paddock_token: "Bearer paddock_…"
    value_template: "{{ value_json.instances | selectattr('ollama_ok') | list | length }}"
    json_attributes:
      - instances
    scan_interval: 60
```

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/tokens` | `{tokens}`: your own, each `{id, kind, name, scopes, created, expires, last_used, expired}`. Admins can add `?all=1` for every user's, with `user` |
| POST | `/api/tokens` | `{name, scopes, expires_days}` → the token's fields plus `token` (201), the only time it is returned. `scopes` defaults to `["api:read"]`; `expires_days` is 1–3650, or `null`/omitted for never. 403 for a scope your role can't grant; 409 past 50 tokens |
| DELETE | `/api/tokens/{id}` | Revokes your own token, or anyone's as an admin; 404 otherwise |

`kind` is `api` for every token today. The wall display's links ([#11](https://github.com/SplendidChip758/llama-paddock/issues/11), scope `display:read`) and the gateway's client keys ([#26](https://github.com/SplendidChip758/llama-paddock/issues/26), scope `gateway:invoke`) will be credentials of other kinds with their own scopes, revoked and listed the same way. A display link will only open the display, and a gateway key only call `/v1`.

## Users

Admins only. With `PADDOCK_AUTH=off` these return 400. `{name}` is matched without regard to case.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/users` | `{users}`: each `{username, role, must_change}` |
| POST | `/api/users` | `{username, role}` → `{username, password}` (201). `role` is `admin` or `viewer` (default). `password` is a temporary one, returned only here, that must be changed at first sign-in. 409 if the name is taken |
| PUT | `/api/users/{name}` | `{role}` → `{username, role, must_change}`; applies to the user's current sessions at once |
| POST | `/api/users/{name}/reset` | → `{password}`: a new temporary password, returned only here; signs the user out |
| DELETE | `/api/users/{name}` | Removes the account and signs it out |

An admin can't change the role of, reset or remove their own account (400).

## Audit log

Admins only, with a session or a token whose user is an admin; 403 for viewers. What it records is described under [Security](security.md#audit-log).

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/audit` | `{entries, next, users, instances}`, newest first. Each entry is `{id, t, user, credential, credential_id, ip, action, instance, instance_name, target, detail}`. Filters: `?user=`, `?instance=` (a host id) and `?action=`, either one action such as `model.delete` or a group such as `model`. `limit` is 1–500 (default 100); pass `next` as `?before=` for older entries, until it is `null`. `users` and `instances` list who and which hosts appear in the log, for filters |

`user` is `null` with `PADDOCK_AUTH=off` and for a failed sign-in to an account that doesn't exist. `credential` and `credential_id` name the API token a change came with, or are `null` for a browser. `instance_name` is the host's name at the time, so it survives the host being renamed or removed. The actions are `auth.login`, `auth.login_failed`, `auth.password`, `user.add`, `user.role`, `user.reset`, `user.remove`, `token.create`, `token.revoke`, `host.add`, `host.edit`, `host.remove`, `host.agent_https`, `host.agent_key`, `ollama.restart`, `ollama.gpu_fix`, `env.change`, `model.pull`, `model.create`, `model.upload`, `model.copy`, `model.delete`, `model.load`, `model.unload`, `job.cancel`, `alert.rules`, `alert.channels`, `alert.silence`, `alert.unsilence`, `benchmark.start`, `benchmark.cancel`, `benchmark.delete`, `settings.client_names`, `security.dismiss`, `security.undismiss`, `security.fix`, `config.export` and `config.import`. New actions may be added.

## Configuration export

Admins with a browser session only: an API token gets 403, since an export holds every secret and an import adds accounts. With `PADDOCK_AUTH=off`, anyone who reaches the dashboard can use them. What an export holds and how an import merges are described under [Operations](operations.md#configuration-export).

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/config/export` | `{passphrase, password}` or `{unencrypted: true, password}` → the export file as a download (`Content-Disposition: attachment`). `password` is the admin's own; 400 when it's wrong or the passphrase is shorter than 12 characters |
| POST | `/api/config/import` | `{file, passphrase, sections, dry_run}` → `{export, items, counts, applied, written}`, plus `signed_out` after an import. `file` is the export's JSON; `passphrase` is `null` for an unencrypted one; `sections` limits it (default all, see below). With `dry_run: true` nothing is written. 400 for a wrong passphrase, a damaged file or one from a newer version |

`sections` are `hosts`, `users`, `tokens`, `rules`, `channels`, `clients`, `dismissals` and `config`. `export` is `{app_version, created, source, encrypted}`. Each item is `{section, key, label, action, reason}` with `action` `add`, `replace` or `skip`, and `reason` saying why one is skipped. `counts` is `{add, replace, skip}`. `signed_out` is `true` when the import replaced the signed-in account. An admin who hasn't replaced the initial password yet may import too, so a fresh install can start from an export.

## Hosts

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances` | `{poll_interval, instances}` with latest status, stats, loaded models, the Ollama `version`, the `agent_version` and `agent_protocol` (`null` if unknown), `agent_incompatible` (`update-agent`, `update-dashboard` or `null`; see [Agent protocol](#agent-protocol)), and `agent_update` (see [Agent updates](#agent-updates)). Each loaded model has `split` and, once its `/api/show` has been read, `context`; each host has `gpu_check` and `reload_churn`. See [Context and reloads](context-and-reloads.md) |
| GET | `/api/instances/{id}/history` | Recent samples or a requested range; see [History](#history) |
| GET | `/api/instances/{id}/events` | Availability and model load events over a range; see [Events](#events) |
| GET | `/api/instances/{id}/requests?range=…` | The host's requests from Ollama's log; see [Requests](#requests) |
| GET | `/api/instances/{id}/requests/log?range=…&sort=…` | One page of the host's requests, latest or slowest first; see [Requests](#requests) |
| GET | `/api/request-clients` | `{names}`: names given to client addresses, `{"192.168.30.20": "open-webui"}` |
| PUT | `/api/request-clients` | `{names}` → `{names}`; replaces them all, and a blank name removes one |
| GET | `/api/instances/{id}/uptime?range=…` | Ollama's and the agent's availability as timelines and outages; see [Uptime](#uptime) |
| GET | `/api/uptime?range=…` | `{range, hosts}`: every host's `coverage` and, for `ollama` and `agent`, `up_pct` and the number of `outages` |
| POST | `/api/instances` | Host fields below → `{id}` (201) |
| PUT | `/api/instances/{id}` | Host fields below → `{id}` |
| DELETE | `/api/instances/{id}` | Removes a UI-defined host and its stored metric history, events and alert transitions; its firing alerts resolve |
| POST | `/api/test-connection` | Host fields plus optional existing `id` → separate `ollama` and `agent` results; `agent.fingerprint` is the key the agent presented (`https://`) or reports (`http://`) |
| POST | `/api/instances/{id}/agent-key` | `{fingerprint}` → pins that key for an `https://` agent, e.g. after its key was replaced; 409 when `config.yaml` sets it |
| GET | `/api/instances/{id}/gpu-check` | `{check}`: the [GPU check](gpu-check.md) as of the last poll, the same as `gpu_check` in `/api/instances`; `null` without an agent, an NVIDIA GPU or Ollama answering |
| POST | `/api/instances/{id}/gpu-check` | Reads Ollama's log and settings again → `{check}` |
| POST | `/api/instances/{id}/gpu-check/fix` | `{action}`: `restart` or `reload_uvm` (Linux agents from 0.8.0, as root, outside a container) → the agent's `{ok, stderr}` |
| POST | `/api/instances/{id}/agent-update` | Starts updating the host's agent to the newest release → the update `run` (below); 409 when it's already running or the dashboard can't update this agent |
| POST | `/api/agent-updates` | Starts updating every outdated agent the dashboard can update → `{started, skipped, failed}`: host ids, and `{id, detail}` for the agents skipped (they need updating on the host) or that refused |
| GET | `/api/agent-releases` | `{channel, platforms}`: the release channel agents are compared with (`stable`, `dev` or `off`), and per platform (`linux`, `windows`) the `latest` version, when it was `checked`, the last `error` and the releases page `url`. `?refresh=1` asks GitHub again first, at most once a minute |
| POST | `/api/instances/{id}/agent-https` | Switches a UI host's `http://` agent URL to `https://`, pinning the key the agent reports → `{id, agent_url, agent_fingerprint}`; 409 for `config.yaml` hosts or agents that don't report a key |

Host fields are `name`, `ollama_url`, `ollama_proxy_key`, `agent_url`, `agent_token`, `agent_fingerprint` and `tags`. `agent_fingerprint` applies to `https://` agent URLs: `SHA256:<base64>` as the agent installer prints it (bare base64 and hex are accepted too). Blank pins the key the agent presents on the first connection; omitted keeps the stored pin. `ollama_url` is required. `tags` accepts an array or comma-separated string. Use the ID returned by creation or listed in `/api/instances` in later requests.

Updates replace host fields, so send all values you want to retain. A blank or omitted `agent_token` keeps the stored token when an agent URL is supplied; clearing the agent URL removes its token. Likewise a blank or omitted `ollama_proxy_key` keeps the stored key; send `clear_ollama_proxy_key: true` to remove it. The 0.7.0 prereleases called it `ollama_api_key`, which is still accepted. Neither secret is ever returned: `/api/instances` reports `has_token` and `has_ollama_proxy_key` instead. Changing either endpoint or the token clears that host's metric history, events and alert transitions; changing only the proxy key, the agent URL's scheme or the pinned key keeps them.

Each loaded model in `ps` (Ollama's `/api/ps` entry) also has `split`: `{state, gpu_pct, cpu_bytes}`. `state` is `gpu` (all in VRAM), `partial` (some in system RAM, run by the CPU), `cpu` (none in VRAM), `cloud` (an Ollama cloud model) or `unknown` (Ollama left out `size` or `size_vram`, or they don't add up). `gpu_pct` is the share in VRAM, 0–100, rounded and never 0 or 100 for `partial`; it and `cpu_bytes` are `null` for `cloud` and `unknown`. See [GPU/CPU split](usage.md#gpucpu-split).

For agent encryption, `/api/instances` reports per host `agent_fingerprint` (the pinned key, or `null`), `agent_fingerprint_in_config`, `agent_key_changed` (the key the agent presented instead of the pinned one: the dashboard stops calling the agent until it's accepted) and `agent_https_fingerprint` (the key an `http://` agent reports, so it can be switched). See [encrypted agent connections](security.md#encrypted-agent-connections). Config-defined hosts cannot be updated or removed through the API (409); edit the YAML instead.

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

## Requests

`GET /api/instances/{id}/requests?range=1h|24h|7d|30d` (default `24h`) returns the host's [request log](usage.md#requests):

| Field | Meaning |
|---|---|
| `total` | `{count, errors, avg_ms, max_ms}` over the range; `errors` counts statuses of 400 and above |
| `buckets`, `bucket_s` | `[{t, count, errors}]` per `bucket_s` seconds (60, 900, 10800 or 43200 by range); empty buckets are left out |
| `clients` | The 50 busiest clients: `{client, name, last}` plus the counts. `name` is from `/api/request-clients`, or `null` |
| `endpoints` | The 50 busiest `{method, path}` plus the counts |
| `models` | Requests matched to a model (the one loaded at the time), plus the counts |
| `slowest`, `recent` | The 10 slowest and 50 latest requests: `{t, status, duration_ms, client, method, path, model}` |
| `sync` | `{last_ok, error, unsupported, skipped}`: the last successful read of the agent's log, the last error, whether the agent is too old to read it, and lines skipped in an unknown format |

Times are unix seconds. Monitoring calls (`GET /api/ps`, `/api/version`, `/`) aren't stored.

`GET /api/instances/{id}/requests/log` pages through every request in a range. It takes `range` as above, `sort` (`latest` or `slowest`, default `latest`), `offset` (default 0), `limit` (1–100, default 25) and `to`, the range's end in unix seconds (default now). Pass the `to` from the first page with every later one, so requests that arrive meanwhile don't shift the pages. It returns `{range, sort, from, to, offset, limit, total, requests}`: `total` counts the requests on every page, and each request has the fields of `recent` above.

## Uptime

`GET /api/instances/{id}/uptime?range=24h|7d|30d` (default `30d`) returns `{range, from, to, coverage, ollama, agent}`. `agent` is `null` for a host without an agent. Each of `ollama` and `agent` is:

| Field | Meaning |
|---|---|
| `up_pct` | Share of the observed, known time it was up: `up_s / (up_s + down_s)`, or `null` with neither |
| `up_s`, `down_s` | Seconds up and down |
| `unknown_s` | Seconds watched before its state was first seen, such as after a dashboard start |
| `unobserved_s` | Seconds the dashboard wasn't polling the host |
| `segments` | `[{start, end, state, error?}]` in time order, `state` being `up`, `down`, `unknown` or `unobserved`; `error` is why it was down |
| `outages` | The down segments as `[{start, end, error, ongoing}]`, newest first; `ongoing` is true while the last poll still saw it down |

Unobserved and unknown time count neither as up nor as down. Times are unix seconds.

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

## Alerts

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/alerts` | `{active, store_error}`: alerts that are pending or firing, and the last error saving transitions (`null` when fine) |
| GET | `/api/alerts/rules` | `{rules}` |
| PUT | `/api/alerts/rules` | `{rules}` → `{rules}`; replaces the whole list. Rules left out are deleted, and their firing alerts resolve |
| GET | `/api/alerts/channels` | `{channels}`: [notification channels](alerts.md#notifications), without their secrets |
| PUT | `/api/alerts/channels` | `{channels}` → `{channels}`; replaces the whole list. A blank `url`, `token` or `email.password` keeps the stored one |
| POST | `/api/alerts/channels/test` | `{channel}` → `{ok, detail}`: sends a test message with these settings, saved or not; with an existing `id`, blank secrets use the stored ones |
| GET | `/api/alerts/silences` | `{silences}` in force |
| POST | `/api/alerts/silences` | `{rule, instance, subject, duration_s, note}` → `{silence}` (201); see below |
| DELETE | `/api/alerts/silences/{id}` | Ends a silence or acknowledgement early |
| GET | `/api/alerts/transitions?after=…&limit=…` | `{transitions}` in order: alerts firing and resolving after the transition id `after`, or else the latest `limit` (1–1000, default 200) |

A rule is `{id, name, kind, enabled, threshold, for_s, clear_s, hosts, channels}`:

| Field | Meaning |
|---|---|
| `id` | Letters, digits, `_`, `.` or `-`. Omit it for a new rule to get one made from the name. Keep it when editing: alerts belong to the rule's ID |
| `kind` | `gpu_temp` (°C), `vram` (%), `disk` (%), `host_unreachable`, `agent_unreachable`, `ollama_crash`, `gpu_lost`, `context_short`, `reload_churn` (loads per hour, at most 10000) or `insecure`; see [Alerts](alerts.md#rules) |
| `threshold` | Above 0, at most 150 for `gpu_temp` and 100 for the percentages; `null` for the kinds without one |
| `for_s`, `clear_s` | Whole seconds, 0 to 86400: how long the condition has to hold before firing, and be gone before resolving |
| `hosts` | Host IDs, or `null` for every host including ones added later |
| `channels` | Channel IDs to notify, `null` (or left out) for every channel including ones added later, or `[]` for none |
| `enabled` | `false` keeps the rule without checking it |

An active alert is `{rule, name, kind, instance, subject, state, since, fired_at, value, detail, unknown, flapping, silence}`. `subject` tells apart several alerts of one rule on a host: `gpu0`, `gpu1`, … for GPUs, the path for disks, the check's ID for `insecure`, empty otherwise. `insecure` alerts of the dashboard's own checks have the `instance` `@dashboard`. `state` is `pending` (the condition holds, but not yet for `for_s`) or `firing`. `since` is when the condition was first seen and `fired_at` when it fired. `unknown: true` means the last poll had no data for it, so it can neither fire nor resolve until data comes back; see [Missing data](alerts.md#missing-data). `value` is the reading in the threshold's unit, or `null`. `silence` is the silence or acknowledgement covering it, or `null`.

A silence is `{id, created, rule, instance, subject, until, until_resolved, note}`. `rule`, `instance` and `subject` say what it covers; `null` (or left out) covers any, but a silence needs a `rule`, an `instance`, or both. Give `duration_s` (60 to 2592000) to silence for a while, or `until_resolved: true` with all three of `rule`, `instance` and `subject` to acknowledge one active alert until it resolves (409 if it isn't active). Silences end by themselves; see [Silences](alerts.md#silences).

A channel is `{id, name, type, enabled, send_resolved, url, token, email}`, with `type` `webhook`, `discord`, `slack` or `email`. `url` is for the first three, `token` (sent as `Authorization: Bearer`) for `webhook` only, and `email` is `{host, port, security, username, password, from, to}` with `security` `starttls` (default), `tls` or `none`. `clear_token: true` and `email.clear_password: true` remove a stored secret. Responses leave the secrets out: they show `url_hint` (the URL up to its host), `has_token` and `email.has_password`, plus `status`: `{last_ok, last_error, last_error_at, queued}` since the dashboard started. The JSON the generic webhook receives is described under [Notifications](alerts.md#the-webhooks-json).

A transition is `{id, t, rule, name, kind, instance, subject, state, value, detail, flapping}` with `state` `firing` or `resolved`. The rule's name and kind are copied, so they stay readable after the rule changes. Poll with `after` set to the last `id` you saw to follow new transitions. Transitions follow `history_retention_days`, except the latest one of an alert that is still firing.

## Security checks

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/security` | `{targets, failing, dismissed}`: the [security checks](security-checks.md) of the dashboard and each host, and how many fail or are dismissed |
| GET | `/api/security/dismissals` | `{dismissals}` |
| POST | `/api/security/dismissals` | `{instance, check}` → `{dismissal}` (201): the check fails on purpose |
| DELETE | `/api/security/dismissals/{instance}/{check}` | Counts a dismissed check again (404 if it isn't dismissed) |
| POST | `/api/security/fix` | `{check: "data_files"}` → `{changed, failed}`: sets the data directory to 700 and its files to 600 |

A target is `{instance, name, checks}`, with `instance` a host ID or `@dashboard` for the dashboard itself. A check is `{id, label, state, detail, fix, dismissal}`. `id` is `ollama_open`, `agent_http` or `agent_token` for hosts (the agent ones only for hosts with an agent), and `default_password`, `dashboard_http`, `data_files` or `api_tokens` for the dashboard (the password and token ones only with the login on). `state` is `pass`, `fail`, `unknown` or `dismissed`. `fix` is `null` or `{label}` with one of `href` (a dashboard page), `doc` (a page under `docs/` with its anchor) or `action` (`switch_https` or `chmod_data`, which the dashboard can apply). `dismissal` is `{instance, check, user, t}` or `null`. `GET /api/instances` also returns `security: {failing, dismissed}`.

## Models and jobs

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances/{id}/models` | Installed models from Ollama's `/api/tags`, each with `cloud`: `true` for an Ollama cloud model (Ollama reports `remote_host`, or the tag ends in `cloud`) |
| GET | `/api/library` | Search the Ollama library: `?q=`, `&capability=tools\|vision\|thinking\|embedding\|audio\|cloud`, `&sort=popular\|newest`, `&page=` → `{models, has_more}`. Each model has `name` (what to pull), `path` (its page on ollama.com), `description`, `capabilities`, `sizes`, `pulls`, `tag_count` and `updated`. Read from ollama.com and cached for 10 minutes; 502 when ollama.com can't be reached or read, 404 with `model_library: false` |
| GET | `/api/library/tags` | `?model=qwen3` (or `user/model`) → the model with `tags`: each with `name` (`qwen3:8b`), `digest` (12 hex digits; aliases share one), `size` (bytes as ollama.com rounds them; null for cloud tags), `context`, `input`, `quantization` and `cloud`. Cached for an hour |
| POST | `/api/instances/{id}/models/show` | `{model}` → details, parsed parameters, system prompt and native context length |
| POST | `/api/instances/{id}/models/fit` | `{model, num_ctx?}` → `{model, source, hosts, measurements, estimates}`: where the model would fit at that context on every host, this one first. A model this host doesn't have is read from its registry (`source: "registry"`); 404 when the registry doesn't have it either. `{blob}` instead of `model` estimates a GGUF uploaded to this host (`source: "upload"`). `gpu` (an index of this host's GPUs) estimates on that GPU alone. Read-only. See [Fit estimates](fit-estimates.md) |
| POST | `/api/instances/{id}/models/pull` | `{model}` → background job |
| POST | `/api/instances/{id}/models/create` | `{model, from, parameters?, system?, template?, pull?}` → background job. `from` is the model to layer on; with `pull: true` a `from` the host doesn't have (a library or `hf.co/` name) is pulled first, in the same job. Or `{model, blob, …}` with the digest of an uploaded GGUF instead of `from` |
| POST | `/api/instances/{id}/models/upload` | `{filename, size}` → `{id, chunk_size}`: start uploading a `.gguf` file for a new model. 507 when the dashboard's data directory lacks the space |
| PUT | `/api/instances/{id}/models/upload/{uid}?offset=` | One chunk of the file as `application/octet-stream`, at most `chunk_size` bytes, at the offset received so far (409 otherwise) → `{received, size}`. The first chunk must start like a GGUF file |
| POST | `/api/instances/{id}/models/upload/{uid}` | Finish: the dashboard hashes the file, sends it to Ollama's `/api/blobs` and deletes its copy → `{digest, filename, size, architecture, name, context_length, parameter_count}`. Pass `digest` as `blob` to `models/create` |
| DELETE | `/api/instances/{id}/models/upload/{uid}` | Abandon an upload and delete what arrived. Uploads idle for an hour are dropped |
| POST | `/api/instances/{id}/models/load` | `{model, keep_alive?}` |
| POST | `/api/instances/{id}/models/unload` | `{model}` |
| POST | `/api/instances/{id}/models/delete` | `{model}` |
| POST | `/api/instances/{id}/models/copy` | `{source, destination}` |
| POST | `/api/instances/{id}/chat` | `{model, messages, options?, keep_alive?, think?}` → the answer as newline-delimited JSON events; see [Test prompts](#test-prompts) |
| GET | `/api/benchmarks` | `{benchmarks}`, newest first, without their runs. `?instance=<id>`, `?model=<name>`, `?limit=` 1–500 (default 100); see [Benchmarks](#benchmarks) |
| POST | `/api/benchmarks` | `{model, instances, num_ctx?, repeat?, mode?, cases?}` → `{benchmarks}`, one per host, each started as a job |
| GET | `/api/benchmarks/{bid}` | One benchmark with its `runs` |
| DELETE | `/api/benchmarks/{bid}` | Cancels a running benchmark, keeping its finished runs, or deletes a finished one |
| GET | `/api/jobs` | `{jobs}` containing job status and progress |
| DELETE | `/api/jobs/{jid}` | Cancels a running job, or removes a finished job from the list |

There is no `GET /api/jobs/{jid}`; find the returned job ID in `/api/jobs`. Pull and create responses are job objects, not streamed progress. Poll the jobs endpoint for updates. Pulls can resume after a dashboard restart; running creates are marked interrupted. See [History and jobs](usage.md#history-and-jobs).

### Test prompts

`POST /api/instances/{id}/chat` sends a chat to the host's Ollama (`/api/chat`) and streams the answer back. `messages` is a list of `{role, content}` with `role` `system`, `user` or `assistant`. `options` are Ollama's model options (`temperature`, `num_ctx`, …), `keep_alive` is passed on, and `think` turns thinking on or off for models that support it.

Errors before the answer starts (an unknown model, an unreachable host, a bad body) are ordinary JSON errors with `{detail}`. Ollama answers once the model is loaded, so this can take a while for a large model; after 10 minutes without an answer the request fails with 504. Once Ollama starts answering, the response is `application/x-ndjson`, one event per line:

| Event | Meaning |
|---|---|
| `{type: "token", content, thinking?}` | The next piece of the answer, and of the model's thinking if it has any |
| `{type: "done", stats}` | The last line of a complete answer |
| `{type: "error", detail}` | The answer failed partway; nothing follows |

`stats` holds `ttft_ms` (from sending the request to the first token, timed by the dashboard, so it includes loading the model and reading the prompt), `wall_ms` (to the last line), Ollama's own `load_ms`, `prompt_tokens`, `prompt_ms`, `eval_ms`, `total_ms` and `tokens`, the rates `prompt_tps` and `tps` in tokens per second, and `done_reason` (`stop`, or `length` when `num_predict` cut it off). Ollama's figures are `null` if it left them out. Closing the connection stops the host generating. Viewers can't send prompts, since a prompt loads models.

### Benchmarks

`POST /api/benchmarks` runs the built-in prompt set against `model` on each host in `instances` (host IDs). The hosts run at the same time; a host already running a benchmark is refused with 409. Options:

| Field | Default | Meaning |
|---|---|---|
| `num_ctx` | `4096` | Context sent with every run, 512–262144 |
| `repeat` | `3` | Runs of each prompt, 1–10 |
| `mode` | `warm` | `warm` loads the model once and leaves that load out; `cold` unloads it before every run |
| `cases` | all | Any of `short`, `long_context`, `long_generation` |

Each benchmark is also a job (`kind: "benchmark"`, with `completed` and `total` counting runs), so it shows in the Jobs drawer and `DELETE /api/jobs/{jid}` cancels it too. A model the host doesn't have, or an Ollama cloud model, fails that host's benchmark with an `error`, not the request.

A benchmark is `{id, batch, instance, instance_name, model, state, error, started, finished, spec, conditions, summary, warnings}`, plus `runs` from `GET /api/benchmarks/{bid}`. Benchmarks started together share a `batch`. `state` is `running`, `done`, `error` or `cancelled`; results are saved after every run, so a running benchmark's summary grows as it goes.

- `spec`: `{set, cases, repeat, mode, num_ctx}`. `set` is the prompt set's version: results from different sets don't compare.
- `conditions`: `digest`, `quantization`, `parameter_size`, `family`, `format`, `ollama_version`, `agent_version`, `dashboard_version`, `platform`, `context` (what Ollama loaded the model with), `env` (Ollama settings that change speed or memory, such as `OLLAMA_FLASH_ATTENTION` and `OLLAMA_KV_CACHE_TYPE`; unset ones are left out), `gpus` (`{name, mem_total_mib, driver}`), `cpu_count`, `mem_total` and `other_models` (loaded when it started). Anything the dashboard couldn't find out is `null`; `env`, `gpus`, `cpu_count` and `mem_total` need an agent.
- `runs`: `{case, rep, t, state, stats, size, size_vram, split, context}`. `stats` is the same as a [test prompt](#test-prompts)'s. `state` is whether the model was loaded at the asked context just before the run (`warm`) or not (`cold`). `size`, `size_vram`, `split` and `context` come from `/api/ps` right after the run.
- `summary`: per case, `{case, runs, excluded, tps, prompt_tps, ttft_ms, load_ms, prompt_tokens, tokens, size_vram, split}`. The four timings are `{median, min, max, cv}` over the runs whose `state` matches the mode, with `cv` the coefficient of variation in percent (`null` with one run). `excluded` counts the runs left out.
- `warnings`: sentences on what makes the figures less comparable, such as other loaded models, a partial GPU/CPU split, runs that varied by more than 10%, or a model that changed during the runs.

Results are kept until deleted: history retention doesn't remove them, and neither does removing the host. A benchmark running when the dashboard stops is marked `error` (`interrupted: the dashboard restarted`) and keeps its finished runs. Viewers can read results but not run or delete them.

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

### Agent updates

Each host in `/api/instances` has `agent_update` (`null` without an agent):

| Field | Meaning |
|---|---|
| `platform` | `linux` or `windows`, as the agent reports it; `null` until it answers |
| `latest` | The newest agent release for that platform on the dashboard's channel ([`agent_updates`](configuration.md)); `null` when unknown or when the check is off |
| `outdated` | The agent runs an older version than `latest` |
| `can_update` | The dashboard can update it. Linux agents from 0.10.0 that the installer set up can; older agents and Windows agents are updated on the host |
| `manual_reason` | Why the dashboard can't, when it can't |
| `run` | The update started from the dashboard: `{state, started, ended, from, to, detail, log}`. `state` is `running`, `done` or `failed`; `detail` says why it failed, or that the agent already was on the newest release; `log` is the end of the updater's output after a failure. A finished update is shown for 10 minutes, a failed one until the next attempt |

The dashboard asks GitHub for the agent releases every 6 hours (every 30 minutes after a failure) and keeps the last answer. An update runs on the host: the agent starts its installer's `update-llama-paddock-agent` with the dashboard's channel, which checks the release against its `SHA256SUMS`, keeps the token and key, and restarts the agent. Ollama keeps running. Starting updates is logged in the [audit log](#audit-log) as `host.agent_update`.

## Agent API

The agent listens separately, normally on port 11435, for HTTPS and (unless `PADDOCK_AGENT_HTTP=off`) plain HTTP. All endpoints except `/health` require `Authorization: Bearer <agent-token>`. The dashboard sends this header using the token stored for the host, after checking the agent's key on `https://`. Agents from 0.7.0 on add `fingerprint`, the SHA-256 of their key, to `/health` and `/stats`. With plain HTTP off, an HTTP request gets 426 with `{detail, fingerprint}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Agent version, [protocol](#agent-protocol), platform and hostname; unauthenticated |
| GET | `/stats` | Agent version, [protocol](#agent-protocol), platform, host, NVIDIA GPU and Ollama process stats |
| GET | `/env` | Environment state, including the `allowed` names (agents from 0.6.0) |
| PUT | `/env` | `{vars, restart?}`; replace managed variables on the allowlist, removing omitted ones; preserve variables outside the list. Restarts unless `restart` is `false`. See [preserving settings](#preserve-existing-environment-settings) |
| POST | `/service/restart` | Restart Ollama |
| GET | `/logs?lines=500` | Ollama log tail |
| GET | `/gpu-check` | `{ts, platform, log, nvidia_uvm?}`: the GPU-related lines of Ollama's log since it last started (`log.lines`, and `log.error` when it can't be read), and on Linux the `nvidia_uvm` state (agents from 0.8.0) |
| GET | `/runner-starts?since=…` | `{ts, starts}`: the times (unix seconds, the agent's clock) Ollama logged a model runner starting since `since` (at most a day back; default an hour), and `error` when the log can't be read (agents from 0.8.0) |
| POST | `/gpu/reload-uvm` | Linux, as root, outside a container: stops Ollama, reloads `nvidia_uvm` and starts Ollama → `{ok, steps, stderr}`; 409 where it can't. The Windows agent answers 400 (agents from 0.8.0) |
| GET | `/update` | `{state, result?, log?}`: the agent updater's last run, `idle`, `running` or `failed`; a failed run has systemd's `result` and the end of the updater's output in `log` (Linux agents from 0.10.0) |
| POST | `/update` | `{channel}`: `stable` (default) or `dev`. Starts `update-llama-paddock-agent` for the newest release on that channel as the transient unit `llama-paddock-agent-update`, which restarts the agent → `{ok, channel}`; 409 while one is running or when the installer's updater is missing. Agents that can do this report `self_update: true` in `/health` and `/stats` (Linux agents from 0.10.0) |
| GET | `/requests?since=…` | `{requests, until, more, skipped}`: the request lines in Ollama's log after `since` (unix seconds), at most 5000. A log file has whole-second times, so agents reading one (Windows, `PADDOCK_OLLAMA_LOG`) also return the lines from the second `since` falls in; drop the ones you already have. Ask again from `until` while `more` is true; `skipped` counts lines in an unknown format (agents from 0.8.0) |

### Agent protocol

Agents report `protocol`, a whole number, in `/health` and `/stats` (agents from 0.10.0; older ones speak protocol 1 and leave it out). It is separate from the agent's version. It only goes up when the agent API changes in a way an older dashboard can't follow, such as a route or field removed or changing meaning. Fixes and new optional fields don't change it, and a dashboard keeps working with agents that lack them.

Each dashboard supports a range of protocols, shown in `/api/healthz` as `agent_protocol`. This dashboard supports protocol 1, which every agent released so far speaks.

An agent outside that range is still polled, but the dashboard uses nothing else it reports and makes no other calls to it, which return 409. The host shows **agent incompatible**, `agent_incompatible` in `/api/instances` says what to update (`update-agent` or `update-dashboard`), and the agent counts as down for alerts and metrics until it's back in range. In any protocol, `/health` and `/stats` keep `version` and `protocol`, so a dashboard can always tell what it is talking to.

Upgrade the dashboard first when a new release changes the protocol. A newer dashboard supports the older protocols too, while an agent on a newer protocol stops being used by an older dashboard.

Both agents implement these routes. Installation and configuration: [Linux](agent-linux.md) · [Windows](agent-windows.md).

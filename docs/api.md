# API reference

The dashboard exposes the JSON endpoints used by its UI. Paths below are relative to the dashboard URL, for example `http://192.168.30.100:8080`. These APIs are pre-1.0 and may change; use the documentation matching your installed version.

## Authentication

Dashboard requests use a session cookie, not the agent bearer token. Send JSON bodies with `Content-Type: application/json`; other content types are refused with 415.

1. `POST /api/auth/login` with `{"username":"admin","password":"…"}`. Save the returned `paddock_session` cookie and send it on subsequent requests.
2. If the response has `must_change: true`, call `POST /api/auth/password` with `{"password":"…"}` and save the replacement cookie. Other application endpoints return 403 until this is done. The new password must differ from the old one and contain at least eight characters.
3. Sessions last seven days. Changing the password invalidates other sessions, and so do an admin resetting it or removing the account.
4. Failed logins return 401. After five failures from one address, or 20 from all addresses together, the login returns 429 for five minutes. See [Security](security.md).
5. Accounts have a [role](configuration.md#users-and-roles). A **viewer** may call every `GET` endpoint below except `/api/users`, plus `POST /api/instances/{id}/models/show`, `POST /api/instances/{id}/gpu-check` and its own `/api/auth` routes. Anything else answers 403 with `code: "forbidden"`. An **admin** may call everything.
6. From a browser, requests other than `GET` must come from the dashboard's own origin, or they get 403. `curl` and scripts send no `Origin` or `Sec-Fetch-Site` header and are unaffected. See [Cross-site requests](security.md#cross-site-requests).

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{ok, must_change}` and a session cookie |
| GET | `/api/auth/me` | `{auth, username, role, must_change, min_password}` when auth is enabled; `{auth: false, role: "admin"}` otherwise |
| POST | `/api/auth/password` | `{current, password}`; `current` is optional during the forced first-login change |
| POST | `/api/auth/logout` | Clears the session cookie |
| GET | `/api/healthz` | `{ok, version}`; no login required |
| GET | `/metrics` | Prometheus metrics; needs the scrape token instead of a login, and is off unless configured. See [Prometheus](prometheus.md) |

`PADDOCK_AUTH=off` disables dashboard authentication, and every request has admin rights. Only use it when another layer protects access. See [Login](configuration.md#login). Unauthenticated API requests normally return 401, and failed requests use a JSON `detail` field.

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

## Hosts

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances` | `{poll_interval, instances}` with latest status, stats, loaded models, the Ollama `version` and the `agent_version` (`null` if unknown). Each loaded model has `split` and, once its `/api/show` has been read, `context`; each host has `gpu_check` and `reload_churn`. See [Context and reloads](context-and-reloads.md) |
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
| `kind` | `gpu_temp` (°C), `vram` (%), `disk` (%), `host_unreachable`, `agent_unreachable`, `ollama_crash`, `gpu_lost`, `context_short` or `reload_churn` (loads per hour, at most 10000); see [Alerts](alerts.md#rules) |
| `threshold` | Above 0, at most 150 for `gpu_temp` and 100 for the percentages; `null` for the kinds without one |
| `for_s`, `clear_s` | Whole seconds, 0 to 86400: how long the condition has to hold before firing, and be gone before resolving |
| `hosts` | Host IDs, or `null` for every host including ones added later |
| `channels` | Channel IDs to notify, `null` (or left out) for every channel including ones added later, or `[]` for none |
| `enabled` | `false` keeps the rule without checking it |

An active alert is `{rule, name, kind, instance, subject, state, since, fired_at, value, detail, unknown, flapping, silence}`. `subject` tells apart several alerts of one rule on a host: `gpu0`, `gpu1`, … for GPUs, the path for disks, empty otherwise. `state` is `pending` (the condition holds, but not yet for `for_s`) or `firing`. `since` is when the condition was first seen and `fired_at` when it fired. `unknown: true` means the last poll had no data for it, so it can neither fire nor resolve until data comes back; see [Missing data](alerts.md#missing-data). `value` is the reading in the threshold's unit, or `null`. `silence` is the silence or acknowledgement covering it, or `null`.

A silence is `{id, created, rule, instance, subject, until, until_resolved, note}`. `rule`, `instance` and `subject` say what it covers; `null` (or left out) covers any, but a silence needs a `rule`, an `instance`, or both. Give `duration_s` (60 to 2592000) to silence for a while, or `until_resolved: true` with all three of `rule`, `instance` and `subject` to acknowledge one active alert until it resolves (409 if it isn't active). Silences end by themselves; see [Silences](alerts.md#silences).

A channel is `{id, name, type, enabled, send_resolved, url, token, email}`, with `type` `webhook`, `discord`, `slack` or `email`. `url` is for the first three, `token` (sent as `Authorization: Bearer`) for `webhook` only, and `email` is `{host, port, security, username, password, from, to}` with `security` `starttls` (default), `tls` or `none`. `clear_token: true` and `email.clear_password: true` remove a stored secret. Responses leave the secrets out: they show `url_hint` (the URL up to its host), `has_token` and `email.has_password`, plus `status`: `{last_ok, last_error, last_error_at, queued}` since the dashboard started. The JSON the generic webhook receives is described under [Notifications](alerts.md#the-webhooks-json).

A transition is `{id, t, rule, name, kind, instance, subject, state, value, detail, flapping}` with `state` `firing` or `resolved`. The rule's name and kind are copied, so they stay readable after the rule changes. Poll with `after` set to the last `id` you saw to follow new transitions. Transitions follow `history_retention_days`, except the latest one of an alert that is still firing.

## Models and jobs

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/instances/{id}/models` | Installed models from Ollama's `/api/tags`, each with `cloud`: `true` for an Ollama cloud model (Ollama reports `remote_host`, or the tag ends in `cloud`) |
| POST | `/api/instances/{id}/models/show` | `{model}` → details, parsed parameters, system prompt and native context length |
| POST | `/api/instances/{id}/models/pull` | `{model}` → background job |
| POST | `/api/instances/{id}/models/create` | `{model, from, parameters?, system?}` → background job |
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

## Agent API

The agent listens separately, normally on port 11435, for HTTPS and (unless `PADDOCK_AGENT_HTTP=off`) plain HTTP. All endpoints except `/health` require `Authorization: Bearer <agent-token>`. The dashboard sends this header using the token stored for the host, after checking the agent's key on `https://`. Agents from 0.7.0 on add `fingerprint`, the SHA-256 of their key, to `/health` and `/stats`. With plain HTTP off, an HTTP request gets 426 with `{detail, fingerprint}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Agent version, platform and hostname; unauthenticated |
| GET | `/stats` | Agent version, platform, host, NVIDIA GPU and Ollama process stats |
| GET | `/env` | Environment state, including the `allowed` names (agents from 0.6.0) |
| PUT | `/env` | `{vars, restart?}`; replace managed variables on the allowlist, removing omitted ones; preserve variables outside the list. Restarts unless `restart` is `false`. See [preserving settings](#preserve-existing-environment-settings) |
| POST | `/service/restart` | Restart Ollama |
| GET | `/logs?lines=500` | Ollama log tail |
| GET | `/gpu-check` | `{ts, platform, log, nvidia_uvm?}`: the GPU-related lines of Ollama's log since it last started (`log.lines`, and `log.error` when it can't be read), and on Linux the `nvidia_uvm` state (agents from 0.8.0) |
| GET | `/runner-starts?since=…` | `{ts, starts}`: the times (unix seconds, the agent's clock) Ollama logged a model runner starting since `since` (at most a day back; default an hour), and `error` when the log can't be read (agents from 0.8.0) |
| POST | `/gpu/reload-uvm` | Linux, as root, outside a container: stops Ollama, reloads `nvidia_uvm` and starts Ollama → `{ok, steps, stderr}`; 409 where it can't. The Windows agent answers 400 (agents from 0.8.0) |
| GET | `/requests?since=…` | `{requests, until, more, skipped}`: the request lines in Ollama's log after `since` (unix seconds), at most 5000. A log file has whole-second times, so agents reading one (Windows, `PADDOCK_OLLAMA_LOG`) also return the lines from the second `since` falls in; drop the ones you already have. Ask again from `until` while `more` is true; `skipped` counts lines in an unknown format (agents from 0.8.0) |

Both agents implement these routes. Installation and configuration: [Linux](agent-linux.md) · [Windows](agent-windows.md).

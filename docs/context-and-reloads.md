# Context and reloads

Two common problems look like a bad model rather than a broken setup:

- **A smaller context allocation.** A client can request a smaller `num_ctx` than the host sets. This can limit how much context a request can use, but the allocation alone does not establish why it differs or whether a prompt was truncated.
- **Constant reloads.** When clients send different `num_ctx` values, or a short `keep_alive`, Ollama loads the model again and again. Each request waits for a load, and VRAM churns.

The dashboard explains both on the host's **Diagnostics** tab. Neither is proof of a mistake on its own: a client may want a small context, or a model may be used rarely on purpose. Monitor keeps the compact live readings.

## Context

The **Context (active / max)** column on Monitor shows the context allocated to a loaded model (from Ollama's `/api/ps`) and the most it supports (from `/api/show`), such as `2,048 / 131,072`. The dashboard compares it with what the host sets when a client doesn't: `num_ctx` in the model's Modelfile, or else `OLLAMA_CONTEXT_LENGTH`. Ollama caps either at what the model supports. Diagnostics lists active, configured and maximum context separately. These are allocation/settings values, not measured prompt usage.

| Shown | Means |
|---|---|
| **Below configured context** | The active allocation is below the Modelfile or `OLLAMA_CONTEXT_LENGTH` setting. A client request is one possible cause; the reading alone does not establish the cause or prove truncation. If more context is needed, compare client, model and host settings |
| **No configured context reported** | The model has a small allocation (8192 tokens or less) while supporting far more. This may be a default or a client-selected value. Check the client's `num_ctx`, `OLLAMA_CONTEXT_LENGTH` on the [Environment](usage.md#environment) tab or the Modelfile if more context is needed. A larger context uses more memory |

`OLLAMA_CONTEXT_LENGTH` is read through the agent. Without one, only the Modelfile counts, and the default isn't pointed out, since the dashboard can't see the host's settings. Ollama versions that don't report a loaded model's context in `/api/ps` show no check.

## Reloads

A model loaded more than 10 times in the last hour gets an explanation on Diagnostics, with the likely causes and what to change, and the host's card on the fleet overview gets a **reloading** chip.

| Evidence | Likely cause | Change |
|---|---|---|
| The loads used different context sizes | Clients ask for different `num_ctx` values, and each change loads the model again | Make clients send the same `num_ctx`, or none |
| Another model loaded in the same poll as this one unloaded | The models don't fit in VRAM together, so they push each other out | Smaller models, quantizations or contexts, or separate hosts. `OLLAMA_MAX_LOADED_MODELS` limits how many stay loaded |
| Otherwise | The model unloads between requests: after `OLLAMA_KEEP_ALIVE` (5 minutes by default), or at once when a client sends `keep_alive: 0` | Raise `OLLAMA_KEEP_ALIVE` (`30m`, or `-1` to keep models loaded), and check the `keep_alive` clients send |

The counts come from the model load events the dashboard records on each poll (see [Events](api.md#events)), so they survive a dashboard restart. Models found loaded after a restart of Ollama or the dashboard don't count as loads.

A poll only sees a model that stays loaded until the next poll. A client that sends `keep_alive: 0` loads and unloads its model within one request. So with an agent from 0.8.0 on, the dashboard also reads the times Ollama logged `llama runner started` in the last hour, every 20 polls. Loads in the log that no poll saw are shown as their own warning, without a model name, since the log line doesn't say which model it was. Without the log (no agent, an older agent, or a log the agent can't read), the counts say **at least**. On Windows, `server.log` only covers the current run of Ollama.

## Alerts

Two [alert rules](alerts.md#rules) watch for these:

- **Context below configured**: a loaded model runs with less context than the host sets. Each model has its own alert, which resolves when the model is loaded with enough context or unloaded. Off by default, since a client may ask for a small context on purpose.
- **Model reloading constantly**: a model was loaded more often than the threshold (default 10) in the last hour. Each model has its own alert, and loads that only Ollama's log shows have one for the host.

The [hosts API](api.md#hosts) returns the check as `context` on each loaded model, and the warnings as `reload_churn` on each host.

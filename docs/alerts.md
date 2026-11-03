# Alerts

The dashboard checks alert rules against every poll of every host: GPU temperature, VRAM usage, disk space, unreachable hosts and agents, Ollama crashing, Ollama losing the GPU, models running with a context cut short, and models reloading constantly. Open **Alerts** in the header to see what is firing and to edit the rules. The header shows how many alerts are firing.

Alerts are shown in the dashboard, logged, recorded in `paddock.db`, and sent to the [notification channels](#notifications) you set up: Discord, Slack, email or any webhook.

## Rules

| Rule | Fires when | Threshold | Default |
|---|---|---|---|
| **GPU temperature** | A GPU is hotter than the threshold. Each GPU has its own alert | °C | above 85°C for 2 minutes |
| **VRAM usage** | A GPU's memory is fuller than the threshold | % | above 95% for 5 minutes; off by default, since Ollama keeps models in VRAM on purpose |
| **Disk nearly full** | A filesystem the agent reports is fuller than the threshold: the root filesystem, the paths in the agent's `PADDOCK_DISK_PATHS`, and the one holding `OLLAMA_MODELS`. Each has its own alert | % | above 90% for 5 minutes |
| **Host unreachable** | Neither Ollama nor the agent answers. For a host without an agent, Ollama not answering | | for 1 minute |
| **Agent unreachable** | The agent doesn't answer, or turns down the token or key, while Ollama answers | | for 2 minutes |
| **Ollama crashed or restarted** | Ollama's API is down while the agent answers; or the agent sees a new Ollama server process, the process gone, or fewer runner processes than loaded models | | for 30 seconds; a restart, an exited process or runner fires at once |
| **Ollama lost the GPU** | The [GPU check](gpu-check.md) says the GPU is lost: `nvidia-smi` sees a GPU, but the loaded models run entirely on the CPU, or Ollama's log shows it found no GPU or hit GPU errors. Settings that ask for the CPU don't count | | for 1 minute |
| **Context cut short** | A loaded model runs with less context than the host sets with `num_ctx` in its Modelfile or `OLLAMA_CONTEXT_LENGTH`, so a client probably asked for less. Each model has its own alert. See [Context and reloads](context-and-reloads.md) | | for 1 minute; off by default |
| **Model reloading constantly** | A model was loaded more often than the threshold in the last hour. With the agent, loads too short for a poll to see count too, from Ollama's log. Each model has its own alert | loads/h | above 10 |

The GPU, disk, Ollama crash and lost GPU rules need the agent. The first poll after the dashboard starts sees no restart: a new Ollama process only counts when the previous one was seen in the polls just before. On Windows, the agent can't tell the server process from the runners, so a restart there is noticed when Ollama's processes or API go away, or a runner is missing, rather than by a new process ID. Restarts started from the dashboard (**Restart Ollama**, or saving the environment) don't count as crashes.

A new installation starts with these nine rules for every host. An installation that saved its rules before the **Ollama lost the GPU**, **Context cut short** or **Model reloading constantly** rules existed keeps its saved list: add them on the Alerts page. Each rule has:

- **For:** how long the condition has to hold before the alert fires. Until then it shows as *pending*. `0` fires on the first poll that sees it.
- **Clear for:** how long the condition has to be gone before a firing alert resolves (default 1 minute), so a value hovering around the threshold doesn't fire and resolve on every poll.
- **Hosts:** every host, including ones added later, or a chosen list.
- **Notify:** every [notification channel](#notifications), including ones added later, or a chosen list. Choosing none keeps the rule's alerts in the dashboard only.

Add several rules of the same kind for different thresholds or hosts, for example a lower temperature limit for one GPU host. Disabling or deleting a rule, or taking a host out of it, resolves its firing alerts.

## Flapping

An alert that fires three times within 30 minutes is marked *flapping*. It then has to stay clear for ten times its rule's **Clear for** before it resolves, so a host that keeps dropping out produces one long alert instead of a stream of them. The mark goes away once it stops firing that often.

## Missing data

An alert only changes with data. When a poll has no value for it, because the agent is down, a GPU disappeared from `nvidia-smi`, or the dashboard wasn't running, the alert neither fires nor resolves:

- A *pending* alert is dropped: its duration starts again when the condition is seen again.
- A *firing* alert stays firing, marked *no data*. It resolves only after the condition has been seen clear for its **Clear for**.
- A condition that started while nothing could be seen counts from the first poll that sees it.

A pause in polling longer than `3 × poll_interval + 30` seconds, such as a dashboard restart, breaks every duration the same way. Alerts that were firing when the dashboard stopped are still firing after it starts, and they don't fire a second time.

## Notifications

Under **Notifications** on the Alerts page, add the channels alerts are sent to. Each rule sends to every channel unless you choose some in the rule. A channel gets a message when an alert fires and, unless you turn off **Also send when an alert resolves**, when it resolves. **Send test** sends a test message with the settings in the editor, before you save them.

| Channel | What you need |
|---|---|
| **Discord** | A channel webhook: in Discord, *Edit channel → Integrations → Webhooks → New webhook → Copy webhook URL*. Messages never mention anyone |
| **Slack** | An [incoming webhook](https://api.slack.com/messaging/webhooks) URL, `https://hooks.slack.com/services/…`. Mattermost and Rocket.Chat incoming webhooks take the same messages |
| **Email** | Your mail provider's SMTP server, port and encryption (STARTTLS on 587, TLS on 465), a user name and password (for Gmail or Microsoft 365, an app password), the sender address, and up to 20 recipients. *None* (port 25) is only for a relay on your own network, and can't log in, so a password is never sent unencrypted. The server's certificate is checked |
| **Webhook** | Any URL that takes a JSON `POST`, such as an n8n, Node-RED or Home Assistant webhook. An optional token is sent as `Authorization: Bearer <token>` |

Messages name the rule, the host and what it applies to, such as `Firing: GPU temperature on gpu-01 · GPU0`, followed by the reading, such as `GPU0 (NVIDIA GeForce RTX 3090) at 91°C`. Resolved messages go to the channels that got the firing one.

### The webhook's JSON

```json
{
  "source": "llama-paddock",
  "version": "0.8.0",
  "state": "firing",
  "summary": "Firing: GPU temperature on gpu-01 · GPU0",
  "detail": "GPU0 (NVIDIA GeForce RTX 3090) at 91°C",
  "time": "2026-11-02T09:14:07.000Z",
  "alert": {
    "id": 42, "rule": "gpu-temp", "name": "GPU temperature", "kind": "gpu_temp",
    "instance": "gpu-01", "host": "gpu-01", "subject": "gpu0",
    "value": 91, "detail": "GPU0 (NVIDIA GeForce RTX 3090) at 91°C", "flapping": false, "t": 1793610847
  }
}
```

`state` is `firing`, `resolved` or `test`; a test message has `alert: null`. In `alert`, `instance` is the host's ID and `host` its name, `subject` is `gpu0`, `gpu1`, … for GPUs, a path for disks, and empty otherwise, and `value` is the reading in the rule's unit, or `null`. `id` and `t` are the transition's, as in the [API](api.md#alerts). New fields may be added; existing ones keep their meaning.

### Delivery

Each channel sends its messages one at a time, in order. A message that fails is tried again after 5 seconds, 30 seconds and 2 minutes, or after the time a `429` answer's `Retry-After` asks for. An answer such as `400` or `404` means the channel's settings are wrong, so that message isn't tried again. A channel that is down doesn't hold up the others.

The channel list shows when each channel last sent a message, or why the last one failed. Messages still waiting when the dashboard stops are lost; the alert itself is recorded either way.

Webhook URLs, tokens and SMTP passwords work like passwords. They are stored in `alert-channels.json` (mode 600) and never shown again: leave the field blank when editing to keep the stored one.
## Silences

A silenced alert still shows on the Alerts page and is still recorded, but it doesn't count toward the header's and the hosts' alert badges. On an active alert:

- **Acknowledge** silences it until it resolves. The next time it fires, it's a new alert.
- **Silence for…** silences it for an hour, 8 hours, a day or 7 days, including if it resolves and fires again in that time.

**Silence host for…** on a host's page silences every alert on that host for a while, for maintenance. The **Silences** list on the Alerts page shows what is silenced and until when; **End** stops a silence early. Silences are kept in `paddock.db`, so they survive a restart, and end by themselves when their time is up.

## History

**History** on the Alerts page lists alerts that fired, newest first, with when each fired and resolved and how long it lasted; filter it by host. A host's **N alerts** badge on the overview opens it filtered to that host. It covers the transitions kept for `history_retention_days`.

## Where rules and alerts are stored

Rules are saved in `alert-rules.json` in the [data directory](configuration.md#data-directory) when you first change them. Until then the built-in defaults apply. Each alert firing and resolving, and each silence, is recorded in `paddock.db`, kept for `history_retention_days` like the other history; an alert that is still firing keeps its record however old it is.

If saving to `paddock.db` fails, the Alerts page says so. Alerts keep working, but a restart may forget which ones were firing.

Channels are saved in `alert-channels.json` in the same directory. Rules, channels, active alerts and the recorded transitions are also available through the [API](api.md#alerts).

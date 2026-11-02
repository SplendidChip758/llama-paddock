# Alerts

The dashboard checks alert rules against every poll of every host: GPU temperature, VRAM usage, disk space, unreachable hosts and agents, and Ollama crashing. Open **Alerts** in the header to see what is firing and to edit the rules. The header shows how many alerts are firing.

Alerts are shown in the dashboard, logged, and recorded in `paddock.db`. Sending them to Discord, Slack, email or a webhook is not available yet.

## Rules

| Rule | Fires when | Threshold | Default |
|---|---|---|---|
| **GPU temperature** | A GPU is hotter than the threshold. Each GPU has its own alert | °C | above 85°C for 2 minutes |
| **VRAM usage** | A GPU's memory is fuller than the threshold | % | above 95% for 5 minutes; off by default, since Ollama keeps models in VRAM on purpose |
| **Disk nearly full** | A filesystem the agent reports is fuller than the threshold: the root filesystem, the paths in the agent's `PADDOCK_DISK_PATHS`, and the one holding `OLLAMA_MODELS`. Each has its own alert | % | above 90% for 5 minutes |
| **Host unreachable** | Neither Ollama nor the agent answers. For a host without an agent, Ollama not answering | | for 1 minute |
| **Agent unreachable** | The agent doesn't answer, or turns down the token or key, while Ollama answers | | for 2 minutes |
| **Ollama crashed or restarted** | Ollama's API is down while the agent answers; or the agent sees a new Ollama server process, the process gone, or fewer runner processes than loaded models | | for 30 seconds; a restart, an exited process or runner fires at once |

The GPU, disk and Ollama crash rules need the agent. The first poll after the dashboard starts sees no restart: a new Ollama process only counts when the previous one was seen in the polls just before. On Windows, the agent can't tell the server process from the runners, so a restart there is noticed when Ollama's processes or API go away, or a runner is missing, rather than by a new process ID. Restarts started from the dashboard (**Restart Ollama**, or saving the environment) don't count as crashes.

A new installation starts with these six rules for every host. Each rule has:

- **For:** how long the condition has to hold before the alert fires. Until then it shows as *pending*. `0` fires on the first poll that sees it.
- **Clear for:** how long the condition has to be gone before a firing alert resolves (default 1 minute), so a value hovering around the threshold doesn't fire and resolve on every poll.
- **Hosts:** every host, including ones added later, or a chosen list.

Add several rules of the same kind for different thresholds or hosts, for example a lower temperature limit for one GPU host. Disabling or deleting a rule, or taking a host out of it, resolves its firing alerts.

## Flapping

An alert that fires three times within 30 minutes is marked *flapping*. It then has to stay clear for ten times its rule's **Clear for** before it resolves, so a host that keeps dropping out produces one long alert instead of a stream of them. The mark goes away once it stops firing that often.

## Missing data

An alert only changes with data. When a poll has no value for it, because the agent is down, a GPU disappeared from `nvidia-smi`, or the dashboard wasn't running, the alert neither fires nor resolves:

- A *pending* alert is dropped: its duration starts again when the condition is seen again.
- A *firing* alert stays firing, marked *no data*. It resolves only after the condition has been seen clear for its **Clear for**.
- A condition that started while nothing could be seen counts from the first poll that sees it.

A pause in polling longer than `3 × poll_interval + 30` seconds, such as a dashboard restart, breaks every duration the same way. Alerts that were firing when the dashboard stopped are still firing after it starts, and they don't fire a second time.

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

Rules, active alerts and the recorded transitions are also available through the [API](api.md#alerts).

# Prometheus and Grafana

The dashboard can serve its latest readings at `/metrics` in the Prometheus text format, so Prometheus can keep long-term history, Grafana can chart it next to your other systems, and Alertmanager can warn you when a host goes down or a GPU runs hot.

`/metrics` reports what the dashboard's poller saw last: it doesn't call the hosts itself, so scraping it is cheap. Values change every `poll_interval` seconds (3 by default); scraping more often than that gains nothing.

## Turning it on

`/metrics` is off by default and answers 404. Prometheus can't sign in to the dashboard, so the endpoint skips the login and checks its own scrape token instead. Set one of these in [`config.yaml`](configuration.md#dashboard-settings) and restart the dashboard:

| Setting | Meaning |
|---|---|
| `metrics_token` | Scrape token. Requests need `Authorization: Bearer <token>`, or get 401. Supports `${VAR}`. The `PADDOCK_METRICS_TOKEN` environment variable is used when this is unset or empty |
| `metrics_open` | `true` serves `/metrics` without a token. Ignored when a token is set |

```yaml
metrics_token: ${PADDOCK_METRICS_TOKEN}
```

Generate a long random token, for example `openssl rand -hex 32`, and put it in the environment file (`/etc/llama-paddock/llama-paddock.env` for the installer, `.env` for Docker Compose).

Leave the endpoint open only when nothing untrusted can reach the dashboard's port. The metrics don't include tokens or passwords, but they do list your hosts, models, GPUs and versions. The token only guards `/metrics`: it can't sign in or call any other endpoint.

## Scrape config

```yaml
scrape_configs:
  - job_name: llama-paddock
    honor_labels: true
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/paddock-metrics-token
    static_configs:
      - targets: ["192.168.30.100:8080"]
```

`honor_labels: true` matters: every series carries an `instance` label with the Ollama host's ID, and without it Prometheus would replace that with the dashboard's address and rename the host's to `exported_instance`. Use `credentials: <token>` instead of `credentials_file` if you prefer to keep it in the config. Prometheus older than 2.26 uses `bearer_token` or `bearer_token_file` instead of the `authorization` block.

To check the endpoint by hand:

```bash
curl -H "Authorization: Bearer $PADDOCK_METRICS_TOKEN" http://192.168.30.100:8080/metrics
```

## Labels

| Label | On | Meaning |
|---|---|---|
| `instance` | every host series | The host's ID, as in `/api/instances` and the dashboard URL |
| `name` | every host series | The host's display name |
| `gpu`, `uuid`, `gpu_name` | `paddock_gpu_*` | GPU index on the host, its UUID and model name |
| `model` | `paddock_ollama_model_*` | Ollama model name, e.g. `llama3.1:8b` |
| `path` | `paddock_host_disk_*` | Mount point the agent reports |

## Metrics

All metrics are gauges, in base units: bytes, seconds, hertz, watts, degrees Celsius, and ratios from 0 to 1 instead of percentages.

| Metric | Extra labels | Meaning |
|---|---|---|
| `paddock_build_info` | `version` | Dashboard version; always 1, and the only series without `instance` |
| `paddock_ollama_up` | | 1 if the last poll of Ollama's API succeeded, 0 if not |
| `paddock_agent_up` | | 1 if the last poll of the agent succeeded, 0 if not. Only for hosts with an agent |
| `paddock_last_poll_timestamp_seconds` | | Unix time of the last poll of the host |
| `paddock_ollama_info` | `version` | Ollama version; always 1 |
| `paddock_agent_info` | `version`, `platform` | Agent version and `linux` or `windows`; always 1 |
| `paddock_ollama_loaded_models` | | Models loaded in Ollama |
| `paddock_ollama_model_size_bytes` | `model` | Memory a loaded model uses, VRAM plus system RAM |
| `paddock_ollama_model_vram_bytes` | `model` | VRAM a loaded model uses |
| `paddock_ollama_model_context_length` | `model` | Context length the model was loaded with, in tokens |
| `paddock_ollama_model_expires_timestamp_seconds` | `model` | Unix time when Ollama unloads the model if it stays idle |
| `paddock_gpu_info` | `driver` | NVIDIA driver version; always 1 |
| `paddock_gpu_utilization_ratio` | | GPU core utilization |
| `paddock_gpu_memory_utilization_ratio` | | GPU memory controller utilization |
| `paddock_gpu_memory_used_bytes` | | VRAM in use |
| `paddock_gpu_memory_total_bytes` | | VRAM size |
| `paddock_gpu_temperature_celsius` | | GPU temperature |
| `paddock_gpu_fan_ratio` | | Fan speed. Missing on passively cooled cards |
| `paddock_gpu_power_watts` | | Power draw |
| `paddock_gpu_power_limit_watts` | | Power limit |
| `paddock_gpu_sm_clock_hertz` | | SM (core) clock |
| `paddock_gpu_sm_clock_max_hertz` | | Maximum SM clock |
| `paddock_gpu_memory_clock_hertz` | | Memory clock |
| `paddock_host_cpu_utilization_ratio` | | CPU utilization over all cores |
| `paddock_host_cpus` | | Logical CPUs |
| `paddock_host_load1`, `paddock_host_load5`, `paddock_host_load15` | | Load averages. Not reported for Windows hosts, which have none |
| `paddock_host_uptime_seconds` | | Host uptime |
| `paddock_host_memory_total_bytes` | | RAM size |
| `paddock_host_memory_used_bytes` | | RAM in use (total minus available) |
| `paddock_host_memory_available_bytes` | | RAM available |
| `paddock_host_swap_total_bytes`, `paddock_host_swap_used_bytes` | | Swap size and use |
| `paddock_host_disk_total_bytes`, `paddock_host_disk_used_bytes`, `paddock_host_disk_free_bytes` | `path` | Filesystem size, use and free space |
| `paddock_host_network_receive_bytes_per_second`, `paddock_host_network_transmit_bytes_per_second` | | Network throughput over all interfaces |
| `paddock_ollama_process_resident_memory_bytes` | | Resident memory of the Ollama server and its runners |
| `paddock_ollama_runners` | | Ollama runner processes |

The `paddock_gpu_*` and `paddock_host_*` series, and the two Ollama process metrics, come from the [agent](agent-linux.md). Hosts without one only report the Ollama series.

### Missing values

- A reading the host doesn't provide (no fan sensor, the first network sample after an agent restart) is left out rather than reported as `NaN`.
- When Ollama is down, its `up` is 0 and the host has no model series. When the agent is down, its `up` is 0 and the host has no GPU or host series: the last readings aren't repeated as if they were current.
- Right after the dashboard starts, a host appears once its first poll finishes, a few seconds later, so a restart doesn't look like an outage.

Example alerts:

```yaml
groups:
  - name: llama-paddock
    rules:
      - alert: OllamaDown
        expr: paddock_ollama_up == 0
        for: 2m
      - alert: GpuHot
        expr: paddock_gpu_temperature_celsius > 85
        for: 5m
```

## Grafana dashboard

[`grafana-dashboard.json`](grafana-dashboard.json) is a ready-made dashboard: up status, loaded models and VRAM per model, and GPU utilization, VRAM, temperature and power, CPU and RAM per host, with a host picker. In Grafana, open **Dashboards → New → Import**, upload the file and pick your Prometheus data source. It needs Grafana 10 or newer.

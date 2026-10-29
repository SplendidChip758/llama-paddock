# API

Everything the UI does is plain JSON, so it can be scripted (n8n, Hermes, cron):

| Method | Path | |
|---|---|---|
| GET | `/api/instances` | all instances with latest stats + ps, the Ollama `version` and the `agent_version` (`null` if unknown) |
| GET | `/api/instances/{id}/history` | latest `history_points` polls; `?range=1h\|6h\|24h\|7d\|30d` for a downsampled range |
| GET | `/api/instances/{id}/models` | `ollama list` |
| POST | `/api/instances/{id}/models/show` | `{model}` → details, parsed params, native ctx |
| POST | `/api/instances/{id}/models/pull` | `{model}` → job |
| POST | `/api/instances/{id}/models/create` | `{model, from, parameters, system?}` → job |
| POST | `/api/instances/{id}/models/{load,unload,delete,copy}` | |
| GET / DELETE | `/api/jobs`, `/api/jobs/{id}` | job status / cancel |
| GET / PUT | `/api/instances/{id}/env` | `{vars, restart}` |
| POST | `/api/instances/{id}/restart` | restart Ollama |
| GET | `/api/instances/{id}/logs?lines=500` | log tail |

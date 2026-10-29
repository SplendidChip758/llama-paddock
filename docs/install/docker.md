# Docker

A multi-arch image is published to GHCR for every release:

```bash
cp .env.example .env    # initial dashboard login
docker compose up -d
```

Sign in at `http://<docker-host>:8080`, choose a new password, then **Add host**. Hosts, the login and metric history (`paddock.db`) are kept in the `paddock-data` volume (`/data`).

For the latest prerelease from the `dev` branch, use the `:dev` tag. To build the image yourself instead, swap `image:` for `build: ./dashboard` in `docker-compose.yml`. In an unprivileged LXC, Docker needs `nesting=1,keyctl=1`.

`config.yaml` is optional: mount it for `poll_interval`, `history_points` / `history_retention_days`, or to define hosts declaratively (those are read-only in the UI). It expands `${VAR}` from the environment, so tokens can stay in `.env`.

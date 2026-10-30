# Security

What the dashboard and the agents trust, and how to expose them without handing that trust to the wrong people.

## What a login can do

A signed-in user can do everything the dashboard offers on every host: pull models from any registry, delete them, edit Ollama's environment and restart it. On a host with an agent, editing the environment and restarting Ollama comes close to running code on that host, which is why the agent only accepts the [variables Ollama reads](usage.md#environment). Treat the dashboard password like root on your Ollama hosts: use a long one, and don't reuse it.

## Exposing the dashboard

The dashboard is designed for a trusted LAN or a reverse proxy, not the open internet.

- **Keep it on the LAN.** The installer and `docker-compose.yml` listen on port 8080 on every interface. Firewall it to the networks that need it.
- **Use TLS from anywhere else.** Put a reverse proxy with TLS in front (Caddy, nginx, Traefik), then set `PADDOCK_TRUSTED_PROXIES` ([reverse proxies](proxy.md#the-dashboard-behind-a-proxy)). The session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- **Or let the proxy do the login.** With an authenticating proxy (Authelia, Authentik, Cloudflare Access, …) in front, `PADDOCK_AUTH=off` turns the dashboard's own login off. Only do that when nothing can reach the dashboard's port without going through the proxy.

## Prometheus metrics

`/metrics` doesn't use the login, because Prometheus can't sign in. It's off unless you set a scrape token (`metrics_token` or `PADDOCK_METRICS_TOKEN`), which it compares in constant time, or set `metrics_open: true`. The token only reads metrics; it can't sign in or call the API. The metrics hold no secrets, but they name your hosts, models, GPUs and versions, so only leave the endpoint open on a network you trust. See [Prometheus and Grafana](prometheus.md).

## Login lockout

Failed logins are limited in two ways, and both answer 429 with the time to wait:

- **Per address:** five failures lock that address out for five minutes.
- **For everyone:** 20 failures from all addresses together pause the login for five minutes, before the password is even checked.

The per-address lockout keys on `X-Forwarded-For`. When clients connect directly, Next.js fills that header with the connecting address, but only if the client didn't send one, so a client can choose which address gets locked out. That is what the global limit is for: it can't be spoofed, and it also caps the CPU spent checking passwords. The price is that 20 wrong attempts from anyone pause the login for everyone, so keep the port off untrusted networks.

## Cross-site requests

The session cookie is `SameSite=Lax`, which keeps other websites from using it. Browsers don't count the port as part of a site, though, so a page on another port of the dashboard's host, or on a sibling subdomain, is the *same site* and gets the cookie. To stop such a page from restarting Ollama or pulling a model on your behalf, the dashboard refuses any API request other than `GET` that a browser marks as coming from another origin: `Sec-Fetch-Site` other than `same-origin`, or an `Origin` that doesn't match the request's host. The answer is 403. Scripts and `curl` send neither header and aren't affected.

Request bodies must be `application/json` (415 otherwise), so a cross-origin request from a browser also needs a CORS preflight, which the dashboard doesn't answer.

## Response headers

Every response carries `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. The dashboard can't be put in a frame, which rules out clickjacking from a same-site page. Embedding is planned for the wall display ([#11](https://github.com/SplendidChip758/llama-paddock/issues/11)), for that page only.

## Agents

- Every agent request except `/health` needs the host's `PADDOCK_AGENT_TOKEN`. The token is stored in the dashboard's data directory and sent with every request, so keep that directory private and the agent's port reachable from the dashboard host only ([Linux](agent-linux.md), [Windows](agent-windows.md)).
- Agent traffic is plain HTTP today. Anyone who can sniff the network between the dashboard and a host can copy the token. TLS between the two is planned ([#68](https://github.com/SplendidChip758/llama-paddock/issues/68)); until then, keep them on a network you trust.
- The agent refuses to set variables outside its [allowlist](usage.md#environment), so neither a dashboard login nor a captured token is enough to load code into Ollama through `LD_PRELOAD` and similar. `PADDOCK_AGENT_ENV_ALLOW` extends the list, and it's read only from the agent's own settings on the host, never from the API.

## Ollama's own port

Ollama's API has no authentication. Anyone who can reach port 11434 can pull, delete and run models without the dashboard. That's how Ollama is designed, and the dashboard can't change it: bind Ollama to the LAN and firewall it like the agent, or put it behind a proxy that checks a key ([setup examples](proxy.md#ollama-behind-a-proxy)). Give the host an `ollama_proxy_key` ([configuration](configuration.md#declarative-hosts), or **Proxy key** in Add host) and the dashboard sends it as `Authorization: Bearer <key>` on every Ollama call. The key is stored like agent tokens, in `hosts.json` (mode 600) or `config.yaml`, and never sent to the browser. Without TLS on the proxy it crosses the network in clear text, the same as agent tokens.

## Reporting a problem

Please report vulnerabilities privately, as described in the [security policy](../SECURITY.md).

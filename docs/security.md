# Security

What the dashboard and the agents trust, and how to expose them without handing that trust to the wrong people.

## What a login can do

A signed-in user can do everything the dashboard offers on every host: pull models from any registry, delete them, edit Ollama's environment and restart it. On a host with an agent, editing the environment and restarting Ollama comes close to running code on that host, which is why the agent only accepts the [variables Ollama reads](usage.md#environment). Treat the dashboard password like root on your Ollama hosts: use a long one, and don't reuse it.

## Exposing the dashboard

The dashboard is designed for a trusted LAN or a reverse proxy, not the open internet.

- **Keep it on the LAN.** The installer and `docker-compose.yml` listen on port 8080 on every interface. Firewall it to the networks that need it.
- **Use TLS from anywhere else.** Put a reverse proxy with TLS in front (Caddy, nginx, Traefik), then set `PADDOCK_TRUSTED_PROXIES` as described below. The session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- **Or let the proxy do the login.** With an authenticating proxy (Authelia, Authentik, Cloudflare Access, …) in front, `PADDOCK_AUTH=off` turns the dashboard's own login off. Only do that when nothing can reach the dashboard's port without going through the proxy.

## Login lockout

Failed logins are limited in two ways, and both answer 429 with the time to wait:

- **Per address:** five failures lock that address out for five minutes.
- **For everyone:** 20 failures from all addresses together pause the login for five minutes, before the password is even checked.

The per-address lockout keys on `X-Forwarded-For`. When clients connect directly, Next.js fills that header with the connecting address, but only if the client didn't send one, so a client can choose which address gets locked out. That is what the global limit is for: it can't be spoofed, and it also caps the CPU spent checking passwords. The price is that 20 wrong attempts from anyone pause the login for everyone, so keep the port off untrusted networks.

## Behind a reverse proxy

Have the proxy append the client's address to `X-Forwarded-For`. nginx needs a line for it; Caddy and Traefik do it by default:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then set `PADDOCK_TRUSTED_PROXIES` to the number of proxies between the client and the dashboard (`1` for one proxy, `2` for a CDN in front of it). The dashboard takes that entry from the right of `X-Forwarded-For`, so whatever a client puts in front of it is ignored. The proxy's own address never appears in the header, which is why the setting is a count rather than a list of addresses. With one proxy the default already picks the right entry; set it anyway so a second hop later doesn't silently break the lockout.

## Agents

- Every agent request except `/health` needs the host's `PADDOCK_AGENT_TOKEN`. The token is stored in the dashboard's data directory and sent with every request, so keep that directory private and the agent's port reachable from the dashboard host only ([Linux](agent-linux.md), [Windows](agent-windows.md)).
- Agent traffic is plain HTTP today. Anyone who can sniff the network between the dashboard and a host can copy the token. TLS between the two is planned ([#68](https://github.com/SplendidChip758/llama-paddock/issues/68)); until then, keep them on a network you trust.
- The agent refuses to set variables outside its [allowlist](usage.md#environment), so neither a dashboard login nor a captured token is enough to load code into Ollama through `LD_PRELOAD` and similar. `PADDOCK_AGENT_ENV_ALLOW` extends the list, and it's read only from the agent's own settings on the host, never from the API.

## Ollama's own port

Ollama's API has no authentication. Anyone who can reach port 11434 can pull, delete and run models without the dashboard. That's how Ollama is designed, and the dashboard can't change it: bind Ollama to the LAN and firewall it like the agent. Support for Ollama behind an authenticating proxy is planned ([#5](https://github.com/SplendidChip758/llama-paddock/issues/5)).

## Reporting a problem

Please report vulnerabilities privately, as described in the [security policy](../SECURITY.md).

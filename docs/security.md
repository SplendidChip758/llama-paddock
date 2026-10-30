# Security

What the dashboard and the agents trust, and how to expose them without handing that trust to the wrong people.

## What a login can do

A signed-in user can do everything the dashboard offers on every host: pull models from any registry, delete them, edit Ollama's environment and restart it. On a host with an agent, editing the environment and restarting Ollama comes close to running code on that host, which is why the agent only accepts the [variables Ollama reads](usage.md#environment). Treat the dashboard password like root on your Ollama hosts: use a long one, and don't reuse it.

## Exposing the dashboard

The dashboard is designed for a trusted LAN or a reverse proxy, not the open internet.

- **Keep it on the LAN.** The installer and `docker-compose.yml` listen on port 8080 on every interface. Firewall it to the networks that need it.
- **Use TLS from anywhere else.** Put a reverse proxy with TLS in front (Caddy, nginx, Traefik), then set `PADDOCK_TRUSTED_PROXIES` as described below. The session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- **Or let the proxy do the login.** With an authenticating proxy (Authelia, Authentik, Cloudflare Access, …) in front, `PADDOCK_AUTH=off` turns the dashboard's own login off. Only do that when nothing can reach the dashboard's port without going through the proxy.

## Prometheus metrics

`/metrics` doesn't use the login, because Prometheus can't sign in. It's off unless you set a scrape token (`metrics_token` or `PADDOCK_METRICS_TOKEN`), which it compares in constant time, or set `metrics_open: true`. The token only reads metrics; it can't sign in or call the API. The metrics hold no secrets, but they name your hosts, models, GPUs and versions, so only leave the endpoint open on a network you trust. See [Prometheus and Grafana](prometheus.md).

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

The proxy must also pass the browser's `Host` header through (the `Host $host` line above; Caddy and Traefik do it by default), or forward it as `X-Forwarded-Host`, so the dashboard can tell its own pages from other origins (next section).

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

Ollama's API has no authentication. Anyone who can reach port 11434 can pull, delete and run models without the dashboard. That's how Ollama is designed, and the dashboard can't change it: bind Ollama to the LAN and firewall it like the agent, or put it behind a proxy that checks a key ([examples below](#protect-ollama-with-a-proxy-key)). Give the host an `ollama_proxy_key` ([configuration](configuration.md#declarative-hosts), or **Proxy key** in Add host) and the dashboard sends it as `Authorization: Bearer <key>` on every Ollama call. The key is stored like agent tokens, in `hosts.json` (mode 600) or `config.yaml`, and never sent to the browser. Without TLS on the proxy it crosses the network in clear text, the same as agent tokens.

## Protect Ollama with a proxy key

Ollama can't be given a key: a local `ollama serve` has no authentication ([Ollama docs](https://docs.ollama.com/api/authentication); the API keys there are for ollama.com's hosted API). To require one, put a reverse proxy in front of Ollama that only forwards requests carrying `Authorization: Bearer <key>`, then give the dashboard the same key as the host's **Proxy key**. Make the key a long random string, e.g. `openssl rand -hex 32`.

Whatever the proxy, three things matter:

- **Nothing may bypass it.** If port 11434 is still reachable, the key protects nothing. With the proxy on the Ollama host, keep Ollama on `127.0.0.1` (its default on Linux; answer *no* when the agent installer offers to open it). With the proxy on another machine, firewall 11434 so only the proxy reaches it.
- **Rewrite the `Host` header.** When Ollama listens on `127.0.0.1` it refuses any `Host` that isn't a local name or address with `403 Forbidden`. Each example below sends Ollama its own address instead.
- **Allow long requests.** Loading a large model can take minutes; the dashboard waits up to 10. Pull progress is streamed and should be passed through as it arrives.

All four examples were tested with a missing key (refused), a wrong key (refused), the right key, and streamed pull progress. Use HTTPS on the proxy where you can: without it the key crosses the network in clear text.

### Nginx Proxy Manager

NPM's Access Lists only do Basic auth and IP rules, so the key check goes in the proxy host's **Advanced** tab:

1. **Details:** your domain (e.g. `ollama.home.lan`), scheme `http`, forward hostname **the Ollama machine's IP address**, port `11434`. Use an IP: NPM resolves names through DNS at request time, so a name from a hosts file fails with 502.
2. **SSL:** add a certificate if you can.
3. **Advanced:** paste this, with your key. NPM uses it in place of its own `location /`, and `$server`/`$port` are what you entered under Details.

```nginx
location / {
    # only requests with the key; everything else gets 401
    if ($http_authorization != "Bearer YOUR-LONG-RANDOM-KEY") {
        return 401;
    }
    # Ollama refuses Host names it doesn't know (403), so send its own address
    proxy_set_header Host $server:$port;
    # stream pull progress; loading a large model can take minutes
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_pass $forward_scheme://$server:$port;
}
```

NPM usually runs on another machine, so Ollama has to listen on the LAN: allow only NPM to reach it, e.g. on the Ollama host `ufw allow from <NPM-IP> to any port 11434 proto tcp` followed by `ufw deny 11434/tcp`. In the dashboard, set the host's Ollama URL to `http://ollama.home.lan` (or `https://`); the dashboard must be able to resolve that name.

### Caddy

On the Ollama host, with Ollama on `127.0.0.1:11434`:

```caddyfile
:11443 {
	@nokey not header Authorization "Bearer YOUR-LONG-RANDOM-KEY"
	respond @nokey 401

	reverse_proxy 127.0.0.1:11434 {
		# Ollama refuses Host names it doesn't know (403)
		header_up Host {upstream_hostport}
		# stream pull progress
		flush_interval -1
	}
}
```

The dashboard's Ollama URL is then `http://<ollama-host>:11443`. With a domain name instead of `:11443`, Caddy also gets a certificate for it.

### nginx

On the Ollama host, with Ollama on `127.0.0.1:11434`:

```nginx
server {
    listen 11443;

    location / {
        if ($http_authorization != "Bearer YOUR-LONG-RANDOM-KEY") {
            return 401;
        }
        proxy_pass http://127.0.0.1:11434;
        # Ollama refuses Host names it doesn't know (403)
        proxy_set_header Host 127.0.0.1:11434;
        # stream pull progress; loading a large model can take minutes
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
```

nginx passed progress through even without `proxy_buffering off` in testing; keep it so a slow client can't hold the stream back.

### Traefik

A file-provider config, with Ollama on `127.0.0.1:11434`. Traefik can't answer 401 from a router rule, so requests without the key get **404**: the route only exists for requests that carry it.

```yaml
# static config (traefik.yml)
entryPoints:
  ollama:
    address: ":11443"
providers:
  file:
    filename: /etc/traefik/dynamic.yml
```

```yaml
# dynamic config (dynamic.yml)
http:
  routers:
    ollama:
      entryPoints: [ollama]
      rule: "PathPrefix(`/`) && Header(`Authorization`, `Bearer YOUR-LONG-RANDOM-KEY`)"
      service: ollama
  services:
    ollama:
      loadBalancer:
        # send Ollama its own address as Host, which it accepts
        passHostHeader: false
        servers:
          - url: "http://127.0.0.1:11434"
```

### Check it

```bash
curl -i http://ollama.home.lan/api/version                                                # 401 (404 with Traefik)
curl -i -H "Authorization: Bearer YOUR-LONG-RANDOM-KEY" http://ollama.home.lan/api/version  # 200 and the version
```

Then **Test connection** in the dashboard's host editor: it says whether the proxy wants a key or rejected the one given.

## Reporting a problem

Please report vulnerabilities privately, as described in the [security policy](../SECURITY.md).

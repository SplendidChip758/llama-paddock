# Reverse proxies

Two different proxies, for two different jobs:

- **[The dashboard behind a proxy](#the-dashboard-behind-a-proxy)** gives the dashboard TLS and a public name. The dashboard needs to know about it so the login lockout and cross-site checks see the real client.
- **[Ollama behind a proxy](#ollama-behind-a-proxy)** puts a key in front of Ollama's API, which has none of its own. The dashboard sends the key with every Ollama call.

## The dashboard behind a proxy

Use one whenever the dashboard is reached from outside a trusted LAN, so the login travels over TLS (see [exposing the dashboard](security.md#exposing-the-dashboard)). The session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`. With an authenticating proxy (Authelia, Authentik, Cloudflare Access, …) in front, `PADDOCK_AUTH=off` turns the dashboard's own login off; only do that when nothing can reach the dashboard's port without going through the proxy.

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

The proxy must also pass the browser's `Host` header through (the `Host $host` line above; Caddy and Traefik do it by default), or forward it as `X-Forwarded-Host`, so the dashboard can tell its own pages from other origins ([cross-site requests](security.md#cross-site-requests)).

## Ollama behind a proxy

Ollama can't be given a key: a local `ollama serve` has no authentication ([Ollama docs](https://docs.ollama.com/api/authentication); the API keys there are for ollama.com's hosted API). To require one, put a reverse proxy in front of Ollama that only forwards requests carrying `Authorization: Bearer <key>`, then give the dashboard the same key as the host's **Proxy key**. Make the key a long random string, e.g. `openssl rand -hex 32`.

### Give the dashboard the key

- **In the UI:** enter the key under **Proxy key** in **Add host** or the host editor, and set the host's Ollama URL to the proxy's address. Leaving the field blank when editing keeps the stored key.
- **In `config.yaml`:** add `ollama_proxy_key: ${OLLAMA01_PROXY_KEY}` to the host ([declarative hosts](configuration.md#declarative-hosts)).

The dashboard sends the key as `Authorization: Bearer <key>` on every Ollama call. It's stored like agent tokens, in `hosts.json` (mode 600) or `config.yaml`, and never sent to the browser.

### What every proxy needs

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

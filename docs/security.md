# Security

What the dashboard and the agents trust, and how to expose them without handing that trust to the wrong people.

## What a login can do

An **admin** can do everything the dashboard offers on every host: pull models from any registry, delete them, edit Ollama's environment and restart it. On a host with an agent, editing the environment and restarting Ollama comes close to running code on that host, which is why the agent only accepts the [variables Ollama reads](usage.md#environment). Treat an admin password like root on your Ollama hosts: use a long one, and don't reuse it.

A **viewer** sees what an admin sees, including Ollama's environment, logs and the request log, but can't change anything, manage users or read the [audit log](#audit-log). The dashboard enforces this on the server for every API request other than `GET`, not only by hiding buttons: a new endpoint is admin-only unless it is explicitly marked as read-only. Stored tokens, keys and passwords are never sent to the browser, whatever the role. Give people a viewer account unless they need to change things. See [Users and roles](configuration.md#users-and-roles).

## Audit log

Admins can see who changed what under **Audit log** in the account menu, filtered by user, host and action, or read it from [`/api/audit`](api.md#audit-log). Viewers can't see it, with a session or a token. It records:

- sign-ins and failed sign-ins, password changes, and changes to users and API tokens
- hosts added, edited or removed, agent keys accepted, and agents switched to HTTPS
- Ollama restarts, GPU fixes and environment changes
- model pulls, creates, copies, deletes, loads and unloads, and cancelled jobs
- alert rule, channel and silence changes, benchmarks started, cancelled or deleted, and request client names

Each record has the time, the user, the API token if the change came with one, the client address, the host, what was acted on and a short detail. The detail says **which** environment variables changed, never their values, and that a token, key or password changed, never what to. Prompts are never recorded, so the test prompt isn't logged. A failed sign-in names the account only when it exists: the text typed as a username might be a password. Saving a list of rules, channels or client names that didn't change records nothing.

With `PADDOCK_AUTH=off` changes are still recorded, with the client address but no user. Records are kept for `audit_retention_days` ([settings](configuration.md#dashboard-settings), default 365) in `paddock.db`. Anyone who can write to the data directory can change them, so keep a copy elsewhere if the log has to stand up as evidence.

## Exposing the dashboard

The dashboard is designed for a trusted LAN or a reverse proxy, not the open internet.

- **Keep it on the LAN.** The installer and `docker-compose.yml` listen on port 8080 on every interface. Firewall it to the networks that need it.
- **Use TLS from anywhere else.** Put a reverse proxy with TLS in front (Caddy, nginx, Traefik), then set `PADDOCK_TRUSTED_PROXIES` ([reverse proxies](proxy.md#the-dashboard-behind-a-proxy)). The session cookie is marked `Secure` when the proxy sends `X-Forwarded-Proto: https`.
- **Or let the proxy do the login.** With an authenticating proxy (Authelia, Authentik, Cloudflare Access, …) in front, `PADDOCK_AUTH=off` turns the dashboard's own login off. Only do that when nothing can reach the dashboard's port without going through the proxy.

## API tokens

[API tokens](api.md#api-tokens) let scripts call the API as their user. Each is 256 random bits, shown once and stored as a SHA-256 hash in `credentials.json` (mode 600), so the file can't be used to sign in. Make a token read-only unless the script has to change something: a read-and-write admin token can restart Ollama and edit its environment on every host.

- **Scopes and roles:** a token can only do what both its scopes and its user's current role allow. Demoting a user takes write access from their tokens for good; removing the user removes them.
- **No credential management:** tokens can't create or revoke tokens, manage users or change passwords. Those need a signed-in browser.
- **Expiry and revocation:** set an expiry when you create one, and revoke it under **API tokens** when a script is retired or a token may have leaked. Admins can see and revoke every user's tokens. Each token shows when it was last used (to the minute).
- **Lockout:** five unknown or wrong tokens from one address lock that address out of token requests for five minutes. Unlike the login there is no limit for everyone together: a 256-bit token can't be guessed, and a forgotten script with a revoked token shouldn't lock every other script or person out. Token failures don't count towards the login lockout either.
- **Transport:** like the session cookie, a token crosses the network in clear text unless the dashboard is behind TLS.

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
- Use `https://` agent URLs. Over plain HTTP, anyone who can sniff the network between the dashboard and a host can copy the token. See [encrypted agent connections](#encrypted-agent-connections).
- The agent refuses to set variables outside its [allowlist](usage.md#environment), so neither a dashboard login nor a captured token is enough to load code into Ollama through `LD_PRELOAD` and similar. `PADDOCK_AGENT_ENV_ALLOW` extends the list, and it's read only from the agent's own settings on the host, never from the API.

## Encrypted agent connections

Agents from 0.7.0 on serve HTTPS. On its first start an agent creates an ECDSA key and a self-signed certificate for it (Linux: `/etc/llama-paddock-agent.key` and `.crt`, mode 600 for the key; Windows: `agent.key` and `agent.crt` next to `agent.json`), and its installer prints the key's fingerprint, `SHA256:…`. You can use your own key and certificate instead with `PADDOCK_AGENT_TLS_KEY` and `PADDOCK_AGENT_TLS_CERT` ([Linux](agent-linux.md#https), [Windows](agent-windows.md#settings-and-updates)).

The dashboard doesn't check the certificate against a CA. It **pins the agent's key**, and checks it on every connection before it sends the token:

- Enter the fingerprint the installer printed under **Agent key fingerprint** in Add host, or as `agent_fingerprint` in [`config.yaml`](configuration.md#declarative-hosts). This is the safe way: the dashboard never talks to anything else at that address.
- Leave it blank, and the dashboard pins the key the agent presents on the first connection. **Test connection** shows that key and fills it in, so you can compare it with the installer's output before saving.
- Because the key is pinned rather than the certificate, a new certificate for the same key needs no new pin, and the generated certificate never expires.

If an agent presents a different key, the dashboard stops calling it, marks the agent down, and shows the pinned and the presented fingerprint on the host's page. A new key is expected after you replaced it (`PADDOCK_AGENT_NEW_KEY=1` for the Linux installer, `-NewKey` for the Windows one, or a reinstall). Compare the presented fingerprint with the installer's output, then choose **Accept new key**. Otherwise, something else may be answering at the agent's address. For a host whose `agent_fingerprint` is set in `config.yaml`, change it there.

Hosts that still use `http://` agent URLs show **not encrypted**. Agents from 0.7.0 on serve HTTPS and plain HTTP on the same port, and report their key over HTTP too, so the dashboard offers **Switch to HTTPS** on the host's page and **Switch all to HTTPS** on the overview. The switch pins the key the agent reported over HTTP, after checking that the agent answers over HTTPS with it. Like pinning on the first connection, that trusts the network at that moment. For `config.yaml` hosts, change `agent_url` to `https://` and add `agent_fingerprint` there.

New agent installs serve HTTPS only (`PADDOCK_AGENT_HTTP=off`). Updated agents keep plain HTTP on, so a dashboard from before 0.7.0 keeps working. Turn it off once every dashboard uses `https://`. Over plain HTTP, an agent with HTTP off answers only with a 426 error that names its key.

This covers the dashboard's calls to agents. Its calls to Ollama on port 11434 can go to an `https://` [proxy](proxy.md#ollama-behind-a-proxy).

## Notification channels

[Notification channels](alerts.md#notifications) hold secrets: a Discord or Slack webhook URL lets anyone post to that channel, and an SMTP password is a mail account's. They are stored in `alert-channels.json` in the data directory (mode 600) and never sent to the browser.

- Email logs in only over TLS or STARTTLS, and the mail server's certificate is checked. The *None* setting can't log in.
- Webhook requests don't follow redirects, so a message can't end up somewhere other than the URL you entered.
- The dashboard sends requests to whatever URL a signed-in user enters for a channel. Anyone who can sign in can already control the hosts, so this adds no new access, but keep it in mind when you plan roles ([#10](https://github.com/SplendidChip758/llama-paddock/issues/10)).

## Ollama's own port

Ollama's API has no authentication. Anyone who can reach port 11434 can pull, delete and run models without the dashboard. That's how Ollama is designed, and the dashboard can't change it: bind Ollama to the LAN and firewall it like the agent, or put it behind a proxy that checks a key ([setup examples](proxy.md#ollama-behind-a-proxy)). Give the host an `ollama_proxy_key` ([configuration](configuration.md#declarative-hosts), or **Proxy key** in Add host) and the dashboard sends it as `Authorization: Bearer <key>` on every Ollama call. The key is stored like agent tokens, in `hosts.json` (mode 600) or `config.yaml`, and never sent to the browser. Without TLS on the proxy it crosses the network in clear text, the same as agent tokens.

## Reporting a problem

Please report vulnerabilities privately, as described in the [security policy](../SECURITY.md).

# Security checks

The dashboard checks each host and itself for settings that leave the fleet exposed and are easy to miss. Open **Security** in the header to see every check, why a failing one matters and what fixes it. The header and the fleet overview show how many checks fail.

Each check is **pass**, **fail**, or **unknown** when the dashboard can't tell yet, for example while a host is down. Checks run on every poll; the probe of a proxy's key runs every 10 polls (30 seconds at the default interval).

## Alerts

A failing check fires the **Security check failing** [alert rule](alerts.md#rules), one alert per check and host, so a host that slips back sends a notification. The dashboard's own checks count as a host called *the dashboard*, and only for rules that cover every host. A check has to fail for a minute before it fires. New installations get the rule; an installation that saved its alert rules before it existed keeps its saved list, so add the rule on the Alerts page.

## Dismissing a check

When a failing check is intended, for example plain HTTP on an isolated lab network, an admin can **Dismiss** it with a note saying why. A dismissed check shows the note, who dismissed it and when, doesn't count as failing, and its alert resolves. **Restore** counts it again. Dismissals are per check and host, stored in `security-dismissals.json` in the [data directory](configuration.md#data-directory), recorded in the [audit log](security.md#audit-log), and removed with their host.

## Host checks

### Ollama answers without a key

Ollama's API has no authentication: anyone who can reach it can pull, delete and run models. The check fails when:

- the host has no **Proxy key** and Ollama answers on an address other than loopback: its URL in the dashboard isn't `localhost` or `127.x`, or the agent reports an `OLLAMA_HOST` that binds every interface (`0.0.0.0`, `::`) or a network address. On loopback, with the agent, the check waits for `OLLAMA_HOST`.
- the host has a **Proxy key**, and the proxy answers `/api/version` without it, or Ollama's own port answers without it. That port is the one in `OLLAMA_HOST`, or 11434 without the agent, at the host's address. Answering there means anyone can go around the proxy.

**Fix:** put Ollama behind a proxy that checks a key and give the host its **Proxy key** ([setup examples](proxy.md#ollama-behind-a-proxy)), then bind Ollama to loopback (`OLLAMA_HOST=127.0.0.1:11434`) so only the proxy reaches it. Or, on a network you trust, firewall port 11434 to the machines that need it and dismiss the check.

### Agent over plain HTTP

The dashboard sends the agent token with every agent call. Over `http://`, anyone who can sniff the network between the dashboard and the host can copy it. The check fails for an agent addressed with `http://`. Agents from 0.7.0 on serve HTTPS and report their key, so for a host added in the dashboard the check offers **Switch to HTTPS**, which pins that key. For a `config.yaml` host, set `agent_url` to `https://` and add its `agent_fingerprint` there. An older agent needs updating first. See [encrypted agent connections](security.md#encrypted-agent-connections).

### Weak agent token

The check fails when a host's agent token is missing, a placeholder from an example (`change-me`, `secret`, `token`, …), shorter than 16 characters, or one or two characters repeated. The installers generate 43 random characters.

**Fix:** put a new random token in the agent's settings (`PADDOCK_AGENT_TOKEN` in `/etc/llama-paddock-agent.env` on [Linux](agent-linux.md), `agent.json` on [Windows](agent-windows.md#settings-and-updates)), restart the agent, and enter the same token for the host in the dashboard or `config.yaml`. One way to make one: `openssl rand -base64 32`.

## Dashboard checks

### Initial or well-known password

The check fails when an account still has a password it was handed, from `PADDOCK_PASSWORD`, the log on first start, or an admin's reset. That password works until it's changed at the next sign-in, so anyone who knows it can take the account first. It also fails when an account's password is `PADDOCK_PASSWORD` or a well-known one such as `change-me` from `.env.example`. The page gives counts, not account names, since viewers can open it.

**Fix:** sign in and change the password, or have an admin remove the account under **Users**. Remove `PADDOCK_PASSWORD` from the environment once the first password is changed. The check is skipped with `PADDOCK_AUTH=off`.

### Dashboard over plain HTTP

The check fails when the last request from another machine reached the dashboard over plain HTTP: passwords, session cookies and API tokens then cross the network in clear text. It goes by the most recent request to a name other than `localhost` or `127.x`, and counts `X-Forwarded-Proto: https` from a proxy as HTTPS. It's unknown until the dashboard has been reached from elsewhere since it started.

**Fix:** put a reverse proxy with TLS in front ([the dashboard behind a proxy](proxy.md#the-dashboard-behind-a-proxy)) and stop exposing port 8080 to the network. On a LAN you trust, dismiss the check.

### Data files readable by others

Files in the data directory hold agent tokens, proxy keys, password hashes, the session signing secret and webhook URLs. The check fails when the directory is open to other users (anything beyond 700) or a file in it is (beyond 600), which happens after copying a backup back or editing a file with another tool.

**Fix:** **Make them private** sets the directory to 700 and its files to 600, for an admin. Files the dashboard's user doesn't own are left as they are and listed; fix those with `chown` and `chmod` as root. The check is skipped on Windows.

### API tokens that never expire

The check fails while any [API token](api.md#api-tokens) has no expiry: a leaked one works until someone revokes it. It counts every user's tokens.

**Fix:** under **API tokens**, revoke tokens without an expiry and create new ones that expire. The check is skipped with `PADDOCK_AUTH=off`.

## Not checked yet

Whether a host's Ollama version has a published security advisory arrives with the update checks ([#74](https://github.com/SplendidChip758/llama-paddock/issues/74)).

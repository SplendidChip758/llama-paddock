# Project layout

```
install/          dashboard.sh, agent.sh  (one-line installers)
agent/linux/      paddock-agent.mjs, systemd unit
agent/windows/    paddock-agent.mjs, install.ps1, uninstall.ps1
dashboard/        Next.js app (App Router, TypeScript)
  app/api/        route handlers (the JSON API)
  lib/server.ts   poller, job runner, Ollama/agent clients
  components/     React UI
  lib/auth.ts     login, sessions (checked for every request by proxy.ts)
.github/workflows release.yml (semantic-release: tag, tarball, agents, GHCR image; main + dev)
docs/             documentation, also published on the website (index: docs/README.md)
  images/         screenshots
  logo/           logo-mark.svg (app icon), banner-dark.svg / banner-light.svg (README header)
```

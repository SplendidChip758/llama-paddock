#!/usr/bin/env bash
# Called by semantic-release (@semantic-release/exec prepareCmd) with the next
# version: stamps it into the dashboard and both agents, then builds the
# release assets into dist/ for @semantic-release/github to upload.
set -euo pipefail
version="$1"
tag="v${version}"
cd "$(dirname "$0")/../.."

(cd dashboard && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
sed -i -E "s/^(const VERSION = \")[^\"]*(\";)/\1${version}\2/" \
  agent/linux/paddock-agent.mjs agent/windows/paddock-agent.mjs

export NEXT_TELEMETRY_DISABLED=1
(cd dashboard && npm ci --no-audit --no-fund && npm run build)

rm -rf dist
mkdir -p dist/llama-paddock-dashboard/.next
cp -a dashboard/.next/standalone/. dist/llama-paddock-dashboard/
cp -a dashboard/.next/static dist/llama-paddock-dashboard/.next/static
echo "$tag" > dist/llama-paddock-dashboard/VERSION
tar -C dist -czf "dist/llama-paddock-dashboard-${tag}.tar.gz" llama-paddock-dashboard
cp agent/linux/paddock-agent.mjs dist/paddock-agent-linux.mjs
cp agent/windows/paddock-agent.mjs dist/paddock-agent-windows.mjs
# The Windows installer copies the agent from its own folder, so it ships as a
# zip of the whole folder. No version in the name keeps the
# releases/latest/download/ link in the docs stable.
mkdir -p dist/llama-paddock-agent-windows
cp agent/windows/paddock-agent.mjs agent/windows/install.ps1 agent/windows/uninstall.ps1 \
  dist/llama-paddock-agent-windows/
(cd dist && zip -qr llama-paddock-agent-windows.zip llama-paddock-agent-windows)
(cd dist && sha256sum *.tar.gz *.mjs *.zip > SHA256SUMS)

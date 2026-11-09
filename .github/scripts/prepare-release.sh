#!/usr/bin/env bash
# Called by semantic-release (@semantic-release/exec prepareCmd) with the next
# version: stamps it into the dashboard, then builds the release assets into
# dist/ for @semantic-release/github to upload. The agents are released from
# SplendidChip758/llama-paddock-agent (Linux) and
# SplendidChip758/llama-paddock-win-agent (Windows).
set -euo pipefail
version="$1"
tag="v${version}"
cd "$(dirname "$0")/../.."

(cd dashboard && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)

export NEXT_TELEMETRY_DISABLED=1
(cd dashboard && npm ci --no-audit --no-fund && npm run build)

rm -rf dist
mkdir -p dist/llama-paddock-dashboard/.next
cp -a dashboard/.next/standalone/. dist/llama-paddock-dashboard/
cp -a dashboard/.next/static dist/llama-paddock-dashboard/.next/static
echo "$tag" > dist/llama-paddock-dashboard/VERSION
tar -C dist -czf "dist/llama-paddock-dashboard-${tag}.tar.gz" llama-paddock-dashboard
(cd dist && sha256sum *.tar.gz > SHA256SUMS)

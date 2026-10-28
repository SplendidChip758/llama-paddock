#!/usr/bin/env bash
# llama-paddock dashboard installer — PRERELEASE channel
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/dev/install/dashboard-dev.sh)"
#
# Same as dashboard.sh, and takes the same options, but installs the newest
# prerelease (vX.Y.Z-dev.N, built from the dev branch) after a disclaimer, and
# update-llama-paddock then stays on prereleases. Prereleases are for testing.
# To go back to stable, re-run the normal installer (dashboard.sh from main).
set -euo pipefail

export PADDOCK_VERSION="${PADDOCK_VERSION:-dev}"
export PADDOCK_BRANCH="${PADDOCK_BRANCH:-dev}"
REPO="${PADDOCK_REPO:-SplendidChip758/llama-paddock}"

# From a clone, use the dashboard.sh next to this file; otherwise fetch it from the same branch.
here="${BASH_SOURCE[0]-}"
if [[ -n $here && -f $here && -f $(dirname "$here")/dashboard.sh ]]; then
  exec bash "$(dirname "$here")/dashboard.sh"
fi
exec bash -c "$(curl -fsSL "https://raw.githubusercontent.com/${REPO}/${PADDOCK_BRANCH}/install/dashboard.sh")"

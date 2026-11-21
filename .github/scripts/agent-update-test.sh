#!/usr/bin/env bash
# CI (ci.yml, agent-update): the Linux agent's update paths in docs/agent-linux.md, run for real.
# install/agent.sh installs the latest stable agent in an Ubuntu container with systemd, against a
# fake GitHub (fake-github.mjs) that serves that release and versions of a newer agent. Then:
#   1. update-llama-paddock-agent to the newer agent: the token and the HTTPS key are kept
#   2. a release that doesn't match its SHA256SUMS is refused and changes nothing
#   3. an agent that doesn't start is rolled back to the one before it
#   4. the agent's POST /update, which the dashboard uses: an update, and one that is rolled back
#   5. an update killed half way is rolled back by llama-paddock-agent-recover.service, as at boot
#   6. uninstalling removes the rollback's files too
#
#   agent-update-test.sh STABLE_DIR NEW_AGENT
# STABLE_DIR holds the latest stable agent release's assets (gh release download), named by its
# tag; NEW_AGENT is the paddock-agent.mjs to update to, published here as 64.0.0 and up.
set -euo pipefail
stable_dir=$(realpath "$1") new_agent=$(realpath "$2")
stable=$(basename "$stable_dir")
repo=$(cd "$(dirname "$0")/../.." && pwd)
ct=paddock-agent-update-test image=paddock-installer-test
gh_port=18091 agent=https://127.0.0.1:11435
bridge=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
gh=http://$bridge:$gh_port
work=$(mktemp -d)
releases=$work/releases

cleanup() {
  [[ -n ${gh_pid-} ]] && kill "$gh_pid" 2>/dev/null
  docker rm -f "$ct" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  echo "--- the agent's log"; in_ct journalctl -u llama-paddock-agent -n 30 --no-pager 2>/dev/null || true
  echo "--- the last update"; cat "$work/update.out" 2>/dev/null || true
  exit 1
}
ok() { echo "✔ $*"; }
in_ct() { docker exec "$ct" "$@"; }

# ---------------------------------------------------------------- releases
# the stable release as it is, and its files in the repository at its tag
mkdir -p "$releases/$stable/.repo/linux"
cp "$stable_dir"/* "$releases/$stable/"
cp "$stable_dir/paddock-agent-linux.mjs" "$releases/$stable/.repo/linux/paddock-agent.mjs"
cp "$stable_dir/llama-paddock-agent.service" "$releases/$stable/.repo/linux/llama-paddock-agent.service"
unit_file="$stable_dir/llama-paddock-agent.service"

# release VERSION [AGENT_JS] — publish the newer agent as vVERSION, as its releases are made now:
# a tarball and the files at the tag, all in SHA256SUMS. AGENT_JS replaces the agent
release() {
  local tag=v$1 dir=$releases/v$1
  rm -rf "$dir"
  mkdir -p "$dir/.repo/linux" "$work/pkg/llama-paddock-agent"
  if [[ -n ${2-} ]]; then printf '%s\n' "$2" >"$work/pkg/llama-paddock-agent/paddock-agent.mjs"
  else sed "s/^const VERSION = \"[^\"]*\"/const VERSION = \"$1\"/" "$new_agent" >"$work/pkg/llama-paddock-agent/paddock-agent.mjs"
  fi
  cp "$unit_file" "$work/pkg/llama-paddock-agent/llama-paddock-agent.service"
  tar -C "$work/pkg" -czf "$dir/llama-paddock-agent-linux.tar.gz" llama-paddock-agent
  cp "$work/pkg/llama-paddock-agent/"* "$dir/.repo/linux/"
  (cd "$work/pkg" && sha256sum llama-paddock-agent/* && cd "$dir" && sha256sum llama-paddock-agent-linux.tar.gz) >"$dir/SHA256SUMS"
  rm -rf "$work/pkg"
}
withdraw() { rm -rf "$releases/v$1"; }

grep -q '^const VERSION = "' "$new_agent" || fail "$new_agent has no VERSION to replace"
node "$repo/.github/scripts/fake-github.mjs" "$bridge" "$gh_port" "$releases" "$repo/install/agent.sh" >"$work/fake-github.log" 2>&1 &
gh_pid=$!

# ---------------------------------------------------------------- the machine
docker build -q -t "$image" - >/dev/null <<'EOF'
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv curl ca-certificates >/dev/null \
  && rm -rf /var/lib/apt/lists/*
CMD ["/sbin/init"]
EOF
# systemd as PID 1 in its own cgroup namespace (it needs --privileged), on Docker's bridge network
docker run -d --name "$ct" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
for _ in $(seq 1 30); do in_ct systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
for _ in $(seq 1 10); do curl -fsS "$gh/agent.sh" -o /dev/null 2>&1 && break; sleep 1; done

# ---------------------------------------------------------------- helpers
install() {
  in_ct env PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_GITHUB_API=$gh PADDOCK_GITHUB_URL=$gh PADDOCK_GITHUB_RAW=$gh/raw \
    PADDOCK_SELF_URL=$gh/agent.sh bash -c "$(cat "$repo/install/agent.sh")"
}
# update [ARGS…] — update-llama-paddock-agent, as a user runs it; prints its exit code
update() { local rc=0; in_ct update-llama-paddock-agent "$@" >"$work/update.out" 2>&1 || rc=$?; echo "$rc"; }
health() { in_ct curl -fsSk --max-time 3 "$agent/health" 2>/dev/null; }
version() { health | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' 2>/dev/null; }
wait_version() {
  for _ in $(seq 1 "${2:-60}"); do [[ $(version) == "$1" ]] && return 0; sleep 1; done
  fail "the agent didn't answer as $1 (it answers as: $(version || echo nothing))"
}
call() { in_ct curl -fsSk --max-time 10 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$@"; }
field() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))[process.argv[1]] ?? ''" "$1"; }
# the token and the key the dashboard has: both still work after every update
check_kept() {
  call "$agent/stats" >/dev/null || fail "$1: the token doesn't work any more"
  [[ $(health | field fingerprint) == "$fingerprint" ]] || fail "$1: the HTTPS key changed"
  [[ -z $(in_ct ls /var/lib/llama-paddock-agent-update/in-progress 2>/dev/null) ]] || fail "$1: the update marker was left behind"
}

# ---------------------------------------------------------------- the stable agent, fresh
install >"$work/update.out" 2>&1 || fail "installing $stable failed"
wait_version "${stable#v}"
token=$(in_ct sed -n 's/^PADDOCK_AGENT_TOKEN=//p' /etc/llama-paddock-agent.env)
fingerprint=$(health | field fingerprint)
[[ -n $token && -n $fingerprint ]] || fail "the fresh install has no token or no HTTPS key"
ok "installed the agent $stable, with key $fingerprint"

# ---------------------------------------------------------------- 1. update from stable
release 64.0.0
rc=$(update)
[[ $rc == 0 ]] || fail "updating from $stable to 64.0.0 exited with $rc"
wait_version 64.0.0
check_kept "after updating from $stable"
in_ct systemctl is-enabled --quiet llama-paddock-agent-recover.service || fail "llama-paddock-agent-recover.service isn't enabled"
ok "updated $stable → 64.0.0 with update-llama-paddock-agent: token and key kept"

# ---------------------------------------------------------------- 2. a damaged download
release 64.0.1
echo '// changed' >>"$releases/v64.0.1/.repo/linux/paddock-agent.mjs"
echo damaged >>"$releases/v64.0.1/llama-paddock-agent-linux.tar.gz"
rc=$(update)
[[ $rc != 0 ]] || fail "an agent that doesn't match SHA256SUMS was installed"
grep -q "doesn't match the release's SHA256SUMS" "$work/update.out" || fail "the refusal doesn't say why"
[[ $(version) == 64.0.0 ]] || fail "a refused download changed the agent"
check_kept "after a damaged download"
withdraw 64.0.1
ok "a release that doesn't match SHA256SUMS is refused, and nothing changes"

# ---------------------------------------------------------------- 3. an agent that doesn't start
release 64.0.2 'console.error("this agent is broken on purpose"); process.exit(1);'
rc=$(update)
[[ $rc == 3 ]] || fail "an agent that doesn't start exited with $rc, not 3 (rolled back)"
grep -q "Rolling back to v64.0.0" "$work/update.out" || fail "the update doesn't say it rolled back"
wait_version 64.0.0
[[ $(in_ct cat /opt/llama-paddock-agent/VERSION) == v64.0.0 ]] || fail "VERSION wasn't put back"
check_kept "after rolling back an agent that didn't start"
withdraw 64.0.2
ok "an agent that doesn't answer is rolled back to 64.0.0"

# ---------------------------------------------------------------- 4. updates from the dashboard
release 64.0.3
[[ $(call -X POST -d '{"channel":"stable"}' "$agent/update" | field ok) == true ]] || fail "POST /update didn't start the update"
wait_version 64.0.3 120
for _ in $(seq 1 30); do [[ $(call "$agent/update" | field state) == idle ]] && break; sleep 1; done
[[ $(call "$agent/update" | field state) == idle ]] || fail "GET /update after the update: $(call "$agent/update")"
check_kept "after an update through POST /update"
release 64.0.4 'process.exit(1);'
call -X POST -d '{"channel":"stable"}' "$agent/update" >/dev/null || fail "POST /update didn't start the second update"
for _ in $(seq 1 90); do [[ $(call "$agent/update" 2>/dev/null | field state) == failed ]] && break; sleep 1; done
status=$(call "$agent/update")
[[ $(field state <<<"$status") == failed ]] || fail "GET /update doesn't report the failed update: $status"
grep -q "Rolling back to v64.0.3" <<<"$status" || fail "GET /update's log doesn't show the rollback: $status"
[[ $(version) == 64.0.3 ]] || fail "the failed update didn't leave 64.0.3 running"
check_kept "after an update through POST /update that was rolled back"
withdraw 64.0.4
ok "POST /update updates to 64.0.3, and reports a failed update to 64.0.4 that was rolled back"

# ---------------------------------------------------------------- 5. an update killed half way
# an agent that never answers keeps the installer waiting for it, with the new agent in place
release 64.0.5 'setInterval(() => {}, 60_000);'
in_ct bash -c 'setsid update-llama-paddock-agent >/root/interrupted.out 2>&1 </dev/null &'
for _ in $(seq 1 60); do [[ $(in_ct cat /opt/llama-paddock-agent/VERSION 2>/dev/null) == v64.0.5 ]] && break; sleep 1; done
[[ $(in_ct cat /opt/llama-paddock-agent/VERSION) == v64.0.5 ]] || fail "the update to 64.0.5 never put the new agent in place"
sleep 3
pid=$(in_ct sed -n 's/^pid=//p' /var/lib/llama-paddock-agent-update/in-progress)
in_ct kill -9 "$pid"
# the next boot: llama-paddock-agent-recover.service runs before the agent starts
in_ct systemctl stop llama-paddock-agent
in_ct systemctl start llama-paddock-agent-recover.service
in_ct systemctl start llama-paddock-agent
wait_version 64.0.3
check_kept "after recovering from an interrupted update"
withdraw 64.0.5
ok "an update killed half way is rolled back to 64.0.3 by llama-paddock-agent-recover.service"

# ---------------------------------------------------------------- 6. uninstall
in_ct env PADDOCK_YES=1 uninstall-llama-paddock-agent >"$work/update.out" 2>&1 || fail "uninstalling failed"
for f in /etc/systemd/system/llama-paddock-agent-recover.service /usr/local/sbin/llama-paddock-agent-recover /var/lib/llama-paddock-agent-update; do
  [[ -z $(in_ct ls -d "$f" 2>/dev/null) ]] || fail "uninstalling left $f behind"
done
ok "uninstalling removes the agent and its rollback files"

echo "--- every agent update path passed"

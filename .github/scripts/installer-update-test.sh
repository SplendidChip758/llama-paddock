#!/usr/bin/env bash
# CI (ci.yml, installer-update): the installer's update paths in docs/operations.md, run for real.
# install/dashboard.sh installs the latest stable release in an Ubuntu container with systemd,
# against a fake GitHub (fake-github.mjs) that serves that release and ones built from this
# checkout. Then, on the same data:
#   1. update-llama-paddock to this checkout's build: config, login and hosts are kept, and every
#      documented GET /api endpoint still answers with the fields it had (api-shapes.mjs)
#   2. a release that doesn't match its SHA256SUMS is refused and changes nothing
#   3. a release that doesn't start is rolled back, with the data from before it
#   4. an update asked for from the dashboard runs through llama-paddock-update.path
#   5. an update killed half way is rolled back by llama-paddock-recover.service, as at boot
#   6. a rollback asked for from the dashboard puts the older release and its backup back
#
#   installer-update-test.sh STABLE_DIR NEW_TARBALL
# STABLE_DIR holds the stable release's assets (gh release download), named by its tag;
# NEW_TARBALL is prepare-release.sh's tarball, built as version 64.0.0.
set -euo pipefail
stable_dir=$(realpath "$1") new_tarball=$(realpath "$2")
stable=$(basename "$stable_dir")
repo=$(cd "$(dirname "$0")/../.." && pwd)
ct=paddock-installer-test image=paddock-installer-test
port=18081 gh_port=18090
# the container reaches the fake GitHub on Docker's bridge, and the dashboard is published on loopback
bridge=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
url=http://127.0.0.1:$port gh=http://$bridge:$gh_port
work=$(mktemp -d) jar=$(mktemp)
releases=$work/releases

cleanup() {
  [[ -n ${gh_pid-} ]] && kill "$gh_pid" 2>/dev/null
  docker rm -f "$ct" >/dev/null 2>&1 || true
  rm -rf "$work" "$jar"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  echo "--- the dashboard's log"; in_ct journalctl -u llama-paddock -n 40 --no-pager 2>/dev/null || true
  echo "--- the updater's log"; in_ct cat /var/lib/llama-paddock-update/update.log 2>/dev/null || true
  exit 1
}
ok() { echo "✔ $*"; }
in_ct() { docker exec "$ct" "$@"; }

# ---------------------------------------------------------------- releases
mkdir -p "$releases" "$work/new"
tar -xzf "$new_tarball" -C "$work/new"
mkdir -p "$releases/$stable"
cp "$stable_dir"/llama-paddock-dashboard-*.tar.gz "$stable_dir"/SHA256SUMS "$releases/$stable/"

# release VERSION [SERVER_JS] — publish this checkout's build as vVERSION. The version is compiled
# into the build, so the 64.0.0 it was built as is replaced; SERVER_JS replaces its server.js
release() {
  local v=$1 tag=v$1 dir=$work/build-$1
  rm -rf "$dir" "$releases/$tag"
  cp -a "$work/new" "$dir"
  local app=$dir/llama-paddock-dashboard
  if [[ $v != 64.0.0 ]]; then
    local files; files=$(grep -rlF '64.0.0' "$app/package.json" "$app/.next")
    [[ -n $files ]] || fail "the build has no 64.0.0 to replace"
    xargs sed -i "s/64\.0\.0/$v/g" <<<"$files"
  fi
  echo "$tag" >"$app/VERSION"
  [[ -n ${2-} ]] && printf '%s\n' "$2" >"$app/server.js"
  mkdir -p "$releases/$tag"
  tar -C "$dir" -czf "$releases/$tag/llama-paddock-dashboard-$tag.tar.gz" llama-paddock-dashboard
  (cd "$releases/$tag" && sha256sum -- *.tar.gz >SHA256SUMS)
  rm -rf "$dir"
}
withdraw() { rm -rf "$releases/v$1"; }

node "$repo/.github/scripts/fake-github.mjs" "$bridge" "$gh_port" "$releases" "$repo/install/dashboard.sh" >"$work/fake-github.log" 2>&1 &
gh_pid=$!

# ---------------------------------------------------------------- the machine
docker build -q -t "$image" - >/dev/null <<'EOF'
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv curl ca-certificates >/dev/null \
  && rm -rf /var/lib/apt/lists/*
CMD ["/sbin/init"]
EOF
# systemd as PID 1 in its own cgroup namespace (it needs --privileged), on Docker's bridge network
docker run -d --name "$ct" --privileged --cgroupns=private -p "127.0.0.1:$port:$port" \
  --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
for _ in $(seq 1 30); do in_ct systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
for _ in $(seq 1 10); do curl -fsS "$gh/dashboard.sh" -o /dev/null 2>&1 && break; sleep 1; done

# ---------------------------------------------------------------- helpers
# the installer from this checkout, unattended, with the fake GitHub
install() {
  in_ct env PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_PORT=$port PADDOCK_GITHUB_API=$gh PADDOCK_SELF_URL=$gh/dashboard.sh \
    bash -c "$(cat "$repo/install/dashboard.sh")"
}
# update [ARGS…] — update-llama-paddock, as a user runs it; prints its exit code
update() { local rc=0; in_ct update-llama-paddock "$@" >"$work/update.out" 2>&1 || rc=$?; echo "$rc"; }
version() { curl -fsS --max-time 3 "$url/api/healthz" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version' 2>/dev/null; }
wait_version() {
  for _ in $(seq 1 "${2:-60}"); do [[ $(version) == "$1" ]] && return 0; sleep 1; done
  fail "the dashboard didn't answer as $1 (it answers as: $(version || echo nothing))"
}
login() {
  rm -f "$jar"
  curl -fsS -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$1\"}" "$url/api/auth/login" >/dev/null 2>&1
}
api() { curl -fsS -b "$jar" -H 'Content-Type: application/json' "$@"; }
# the data a user would lose: the login, a host added in the UI, the config and env files
check_data() {
  login password-1 || fail "$1: the login is gone"
  api "$url/api/instances" | grep -q '"name":"kept-host"' || fail "$1: the host added in the UI is gone"
  [[ $(in_ct sha256sum /etc/llama-paddock/config.yaml /etc/llama-paddock/llama-paddock.env) == "$config_sums" ]] \
    || fail "$1: config.yaml or llama-paddock.env changed"
}
marker() { in_ct cat /var/lib/llama-paddock-update/in-progress 2>/dev/null; }
last_history() { in_ct tail -n 1 /var/lib/llama-paddock-update/history.jsonl; }
field() { node -p "JSON.parse(require('fs').readFileSync(0, 'utf8'))[process.argv[1]] ?? ''" "$1"; }

# ---------------------------------------------------------------- the stable release, fresh
install >"$work/install.out" 2>&1 || { cat "$work/install.out"; fail "installing $stable failed"; }
wait_version "${stable#v}"
initial=$(in_ct sed -n 's/^PADDOCK_PASSWORD=//p' /etc/llama-paddock/llama-paddock.env)
login "$initial" || fail "can't sign in with the installer's password"
api -d "{\"current\":\"$initial\",\"password\":\"password-1\"}" "$url/api/auth/password" >/dev/null
login password-1
api -d '{"name":"kept-host","ollama_url":"http://192.168.30.101:11434"}' "$url/api/instances" >/dev/null
# the dashboard reads its own releases from here, for updates from the dashboard (step 4)
in_ct sed -i "1a agent_releases_url: $gh" /etc/llama-paddock/config.yaml
config_sums=$(in_ct sha256sum /etc/llama-paddock/config.yaml /etc/llama-paddock/llama-paddock.env)
ok "installed $stable, with a changed password, a host and a config change"
node "$repo/.github/scripts/api-shapes.mjs" snapshot "$url" password-1 "$repo/docs/api.md" >"$work/api-$stable.json" \
  || fail "couldn't record $stable's API"

# ---------------------------------------------------------------- 1. update from stable
release 64.0.0
rc=$(update)
[[ $rc == 0 ]] || { cat "$work/update.out"; fail "updating from $stable to 64.0.0 exited with $rc"; }
wait_version 64.0.0
check_data "after updating from $stable"
[[ -z $(marker) ]] || fail "an update marker was left behind"
in_ct paddock-backup list | grep -q "${stable}-pre-update" || fail "no pre-update backup of $stable"
[[ $(last_history | field state) == done ]] || fail "the history doesn't record the update: $(last_history)"
ok "updated $stable → 64.0.0 with update-llama-paddock: data kept, pre-update backup taken"
node "$repo/.github/scripts/api-shapes.mjs" compare "$url" password-1 "$repo/docs/api.md" "$work/api-$stable.json" \
  || fail "the API lost fields $stable had (above)"
ok "every documented GET endpoint of $stable still answers with its fields"

# ---------------------------------------------------------------- 2. a damaged download
release 64.0.1
echo damaged >>"$releases/v64.0.1/llama-paddock-dashboard-v64.0.1.tar.gz"
rc=$(update)
[[ $rc != 0 ]] || fail "a release that doesn't match SHA256SUMS was installed"
grep -q "doesn't match its checksum" "$work/update.out" || { cat "$work/update.out"; fail "the refusal doesn't say why"; }
[[ $(version) == 64.0.0 && -z $(marker) ]] || fail "a refused download changed the install"
check_data "after a damaged download"
withdraw 64.0.1
ok "a release that doesn't match SHA256SUMS is refused, and nothing changes"

# ---------------------------------------------------------------- 3. a release that doesn't start
release 64.0.2 'console.error("this release is broken on purpose"); process.exit(1);'
rc=$(update)
[[ $rc == 3 ]] || { cat "$work/update.out"; fail "a release that doesn't start exited with $rc, not 3 (rolled back)"; }
wait_version 64.0.0
check_data "after rolling back a release that didn't start"
[[ -z $(marker) ]] || fail "the rollback left the update marker"
[[ $(last_history | field state) == rolled_back ]] || fail "the history doesn't record the rollback: $(last_history)"
withdraw 64.0.2
ok "a release that doesn't answer is rolled back to 64.0.0 with its data"

# ---------------------------------------------------------------- 4. update from the dashboard
release 64.0.1
login password-1
latest=$(api "$url/api/dashboard-update?refresh=1" | field latest)
[[ $latest == 64.0.1 ]] || fail "the dashboard doesn't offer 64.0.1 (latest: ${latest:-none})"
api -d '{"version":"64.0.1"}' "$url/api/dashboard-update" >/dev/null || fail "the dashboard refused to ask for the update"
wait_version 64.0.1 300
for _ in $(seq 1 60); do [[ $(in_ct cat /var/lib/llama-paddock-update/status.json | field state) == done ]] && break; sleep 1; done
[[ $(in_ct cat /var/lib/llama-paddock-update/status.json | field state) == done ]] \
  || fail "the updater's status isn't done: $(in_ct cat /var/lib/llama-paddock-update/status.json)"
check_data "after an update from the dashboard"
ok "64.0.0 → 64.0.1 asked for from the dashboard, run by llama-paddock-update.path"

# ---------------------------------------------------------------- 5. an update killed half way
# a release that never answers keeps the installer waiting for it, with the releases swapped
release 64.0.3 'setInterval(() => {}, 60_000);'
in_ct bash -c 'setsid update-llama-paddock >/root/interrupted.out 2>&1 </dev/null &'
for _ in $(seq 1 180); do marker | grep -q '^phase=swapped' && break; sleep 1; done
marker | grep -q '^phase=swapped' || fail "the update to 64.0.3 never swapped the releases"
sleep 5
pid=$(marker | sed -n 's/^pid=//p')
in_ct kill -9 "$pid"
# the next boot: llama-paddock-recover.service runs before the dashboard starts
in_ct systemctl stop llama-paddock
in_ct systemctl start llama-paddock-recover.service
in_ct systemctl start llama-paddock
wait_version 64.0.1
[[ -z $(marker) ]] || fail "the recovery left the update marker"
check_data "after recovering from an interrupted update"
withdraw 64.0.3
ok "an update killed half way is rolled back to 64.0.1 by llama-paddock-recover.service"

# ---------------------------------------------------------------- 6. a rollback from the dashboard
login password-1
backup=$(api "$url/api/dashboard-update" | node -p '
  const u = JSON.parse(require("fs").readFileSync(0, "utf8"));
  (u.history.find((h) => h.state === "done" && h.version === "64.0.1" && h.can_roll_back) ?? {}).backup ?? ""')
[[ -n $backup ]] || fail "the dashboard offers no rollback of the update to 64.0.1"
# a backup the updater didn't take: the dashboard's user can write one, but root must not restore it
forged=20200101T000000Z-v64.0.0-pre-update
in_ct runuser -u llama-paddock -- cp -a "/var/lib/llama-paddock/backups/$backup" "/var/lib/llama-paddock/backups/$forged"
in_ct runuser -u llama-paddock -- sh -c "printf '%s' '{\"action\":\"rollback\",\"version\":\"v64.0.0\",\"backup\":\"$forged\",\"requested_at\":0}' \
  > /var/lib/llama-paddock/update-request.json"
for _ in $(seq 1 60); do [[ $(in_ct cat /var/lib/llama-paddock-update/status.json | field backup) == "" \
  && $(in_ct cat /var/lib/llama-paddock-update/status.json | field action) == rollback ]] && break; sleep 1; done
status=$(in_ct cat /var/lib/llama-paddock-update/status.json)
[[ $(field state <<<"$status") == failed && $(field message <<<"$status") == *"isn't one the updater took"* ]] \
  || fail "the updater didn't refuse a backup it hadn't taken: $status"
[[ $(in_ct cat /opt/llama-paddock/VERSION) == v64.0.1 ]] || fail "a refused rollback changed the installed version"
in_ct rm -rf "/var/lib/llama-paddock/backups/$forged"
ok "a backup the updater didn't take is refused for a rollback"
# changed after the backup, so the rollback must undo it
api -d '{"current":"password-1","password":"password-after-backup"}' "$url/api/auth/password" >/dev/null
# changing the password ends the session
login password-after-backup
api -d "{\"action\":\"rollback\",\"backup\":\"$backup\"}" "$url/api/dashboard-update" >/dev/null || fail "the dashboard refused the rollback"
wait_version 64.0.0 300
login password-1 || fail "the rollback didn't restore the backup's login"
if login password-after-backup; then fail "a change made after the backup survived the rollback"; fi
ok "rolled back to 64.0.0 from the dashboard, with the backup taken before the update"

echo "--- every installer update path passed"

#!/usr/bin/env bash
# llama-paddock dashboard installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"
#
# On a Proxmox VE host: creates a new LXC (latest Ubuntu LTS by default, or Debian)
# and installs the dashboard in it.
# Anywhere else (LXC, VM, bare metal; Debian/Ubuntu): installs the dashboard directly.
# Re-running it on an existing install updates it and keeps your config.
#
# Options (environment variables):
#   PADDOCK_VERSION   latest (default) | v1.2.3 | source  — "source" builds PADDOCK_BRANCH
#   PADDOCK_BRANCH    git branch for source builds and helper files (default: main)
#   PADDOCK_REPO      GitHub repo (default: SplendidChip758/llama-paddock)
#   PADDOCK_PORT      port to listen on (default: 8080)
#   PADDOCK_LOCAL=1   install here even on a Proxmox host
#   PADDOCK_YES=1     non-interactive: accept all defaults
#   PADDOCK_TARBALL   path to a prebuilt dashboard tarball (offline install)
#   PADDOCK_SOURCE_DIR path to a local checkout to build from
set -euo pipefail

REPO="${PADDOCK_REPO:-SplendidChip758/llama-paddock}"
BRANCH="${PADDOCK_BRANCH:-main}"
VERSION="${PADDOCK_VERSION:-latest}"
PORT="${PADDOCK_PORT:-8080}"
SELF_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}/install/dashboard.sh"
APP_DIR=/opt/llama-paddock
CFG_DIR=/etc/llama-paddock
DATA_DIR=/var/lib/llama-paddock
SVC_USER=llama-paddock
NODE_MIN="20.9"

# ---------------------------------------------------------------- ui helpers
if [[ -t 1 ]]; then
  C_OK=$'\e[32m'; C_INFO=$'\e[36m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else
  C_OK=""; C_INFO=""; C_WARN=""; C_ERR=""; C_B=""; C_0=""
fi
msg_info() { echo -e " ${C_INFO}▸${C_0} $*"; }
msg_ok()   { echo -e " ${C_OK}✔${C_0} $*"; }
msg_warn() { echo -e " ${C_WARN}!${C_0} $*"; }
die()      { echo -e " ${C_ERR}✖ $*${C_0}" >&2; exit 1; }

header() {
  cat <<EOF
${C_B}
   llama${C_WARN}paddock${C_0}${C_B}  ·  dashboard installer${C_0}
   Monitor & manage your Ollama fleet — github.com/${REPO}

EOF
}

# ask VAR "Question" default  — reads from the terminal even when piped; PADDOCK_YES skips
ask() {
  local __var=$1 __q=$2 __def=${3-} __ans=""
  if [[ -n ${!__var-} ]]; then return; fi          # already set via environment
  if [[ -z ${PADDOCK_YES-} && -r /dev/tty ]]; then
    read -r -p "   ${__q}${__def:+ [${__def}]}: " __ans </dev/tty || true
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

confirm() { # confirm "Question" (default yes)
  local a=""
  [[ -n ${PADDOCK_YES-} || ! -r /dev/tty ]] && return 0
  read -r -p "   $1 [Y/n]: " a </dev/tty || true
  [[ -z $a || $a =~ ^[Yy] ]]
}

# quiet CMD...  — run CMD with its output hidden, printing it only if CMD fails
quiet() {
  local log rc=0; log=$(mktemp)
  "$@" >"$log" 2>&1 || rc=$?
  (( rc == 0 )) || cat "$log" >&2
  rm -f "$log"
  return $rc
}

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

# ================================================================= Proxmox host
proxmox_install() {
  msg_info "Proxmox VE detected — creating a new LXC for the dashboard (set PADDOCK_LOCAL=1 to install on the host instead)"
  echo
  # pct exec passes the host's locale into the container, where it usually isn't
  # generated (perl/apt then warn on every call); C.UTF-8 exists in every template.
  export LANG=C.UTF-8; unset LANGUAGE "${!LC_@}"

  local next_id; next_id=$(pvesh get /cluster/nextid)
  local def_storage; def_storage=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')
  local def_tstorage; def_tstorage=$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')

  ask CT_OS       "Distribution (ubuntu or debian)" "ubuntu"
  CT_OS=${CT_OS,,}
  [[ $CT_OS == ubuntu || $CT_OS == debian ]] || die "unknown distribution '$CT_OS' — use ubuntu or debian"
  ask CT_ID       "Container ID" "$next_id"
  ask CT_HOSTNAME "Hostname" "llama-paddock"
  ask CT_CORES    "CPU cores" "2"
  ask CT_RAM      "Memory (MiB)" "1024"
  ask CT_DISK     "Disk size (GiB)" "6"
  ask CT_STORAGE  "Storage for the root disk" "${def_storage:-local-lvm}"
  ask CT_TSTORAGE "Storage for the CT template" "${def_tstorage:-local}"
  ask CT_BRIDGE   "Network bridge" "vmbr0"
  ask CT_VLAN     "VLAN tag (blank for none)" ""
  ask CT_IP       "IPv4 address in CIDR (e.g. 192.168.20.50/24) or dhcp" "dhcp"
  CT_GW="${CT_GW-}"
  [[ $CT_IP != dhcp ]] && ask CT_GW "Gateway" ""
  echo

  pct status "$CT_ID" &>/dev/null && die "container $CT_ID already exists"

  local pattern label
  case $CT_OS in
    ubuntu) pattern='^ubuntu-[0-9]*[02468]\.04-standard_'; label="Ubuntu LTS" ;;  # LTS = even year, .04
    debian) pattern='^debian-1[2-9]-standard_';             label="Debian" ;;
  esac
  msg_info "Finding the latest $label template"
  pveam update >/dev/null 2>&1 || true
  local template
  template=$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep -E "$pattern" | sort -V | tail -1)
  [[ -n $template ]] || die "no $label standard template found (pveam available --section system)"
  if ! pveam list "$CT_TSTORAGE" 2>/dev/null | grep -q "$template"; then
    msg_info "Downloading $template to $CT_TSTORAGE"
    pveam download "$CT_TSTORAGE" "$template" >/dev/null
  fi
  msg_ok "Template $template"

  local net="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP}"
  [[ -n $CT_GW ]] && net+=",gw=${CT_GW}"
  [[ -n $CT_VLAN ]] && net+=",tag=${CT_VLAN}"

  msg_info "Creating container $CT_ID ($CT_HOSTNAME)"
  pct create "$CT_ID" "${CT_TSTORAGE}:vztmpl/${template}" \
    --hostname "$CT_HOSTNAME" --cores "$CT_CORES" --memory "$CT_RAM" --swap 512 \
    --rootfs "${CT_STORAGE}:${CT_DISK}" --net0 "$net" \
    --unprivileged 1 --features nesting=1 --onboot 1 --ostype "$CT_OS" \
    --tags "llama-paddock" --description "llama-paddock dashboard — https://github.com/${REPO}" >/dev/null
  pct start "$CT_ID"
  msg_ok "Container $CT_ID started"

  msg_info "Waiting for network"
  local i
  for i in $(seq 1 60); do
    pct exec "$CT_ID" -- getent hosts raw.githubusercontent.com &>/dev/null && break
    sleep 1
  done
  pct exec "$CT_ID" -- getent hosts raw.githubusercontent.com &>/dev/null || die "container has no working DNS/network after 60s"
  msg_ok "Network up"

  msg_info "Installing curl in the container"
  pct exec "$CT_ID" -- bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null"

  # run this same script inside the container, non-interactively
  pct exec "$CT_ID" -- env \
    PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_NESTED=1 PADDOCK_REPO="$REPO" PADDOCK_BRANCH="$BRANCH" PADDOCK_VERSION="$VERSION" PADDOCK_PORT="$PORT" \
    bash -c "curl -fsSL '$SELF_URL' | bash"

  local ip; ip=$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}')
  echo
  msg_ok "${C_B}llama-paddock is running in CT ${CT_ID}: http://${ip:-<ct-ip>}:${PORT}${C_0}"
  echo "   Update later from the Proxmox host:  pct exec ${CT_ID} -- update-llama-paddock"
}

# ================================================================= local install
ensure_deps() {
  local need=()
  for c in curl tar; do command -v "$c" >/dev/null || need+=("$c"); done
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
  local have=""
  command -v node >/dev/null && have=$(node -p 'process.versions.node')
  if (( ${#need[@]} )) || [[ -z $have ]] || ! version_ge "$have" "$NODE_MIN"; then
    command -v apt-get >/dev/null || die "missing ${need[*]:-} Node.js >= $NODE_MIN and no apt-get — install them yourself, or use Docker"
  fi
  if (( ${#need[@]} )); then
    msg_info "Installing ${need[*]}"
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null
  fi

  if [[ -z $have ]] || ! version_ge "$have" "$NODE_MIN"; then
    msg_info "Installing Node.js 22 (NodeSource)${have:+ — found $have, need >= $NODE_MIN}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnupg >/dev/null
    quiet bash -o pipefail -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -" \
      || die "NodeSource setup failed"
    quiet env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs || die "could not install nodejs"
  fi
  msg_ok "Node.js $(node -p 'process.versions.node')"
}

# Sets RELEASE_TAG and ASSET_URL from the GitHub API (empty if there is no release)
resolve_release() {
  RELEASE_TAG=""; ASSET_URL=""
  local api="https://api.github.com/repos/${REPO}/releases"
  [[ $VERSION == latest ]] && api+="/latest" || api+="/tags/${VERSION}"
  local json; json=$(curl -fsSL -H "Accept: application/vnd.github+json" "$api" 2>/dev/null) || return 0
  read -r RELEASE_TAG ASSET_URL < <(node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const a = (r.assets || []).find((x) => /^llama-paddock-dashboard-.*\.tar\.gz$/.test(x.name));
    console.log(r.tag_name || "", a ? a.browser_download_url : "");
  ' <<<"$json") || true
}

# Fetches/builds the app into $STAGE (server.js + .next/static + node_modules); sets INSTALLED_VERSION
fetch_app() {
  STAGE=$(mktemp -d /tmp/llama-paddock.XXXXXX)
  WORK=$(mktemp -d /tmp/llama-paddock-src.XXXXXX)
  local work="$WORK"

  if [[ -n ${PADDOCK_TARBALL-} ]]; then
    msg_info "Using prebuilt tarball $PADDOCK_TARBALL"
    tar -xzf "$PADDOCK_TARBALL" -C "$work"
    cp -a "$work"/llama-paddock-dashboard/. "$STAGE"/
    INSTALLED_VERSION=$(cat "$STAGE/VERSION" 2>/dev/null || echo "tarball")
    return
  fi

  local src=""
  if [[ -n ${PADDOCK_SOURCE_DIR-} ]]; then
    src="$PADDOCK_SOURCE_DIR"
    INSTALLED_VERSION="local"
  else
    if [[ $VERSION != source ]]; then
      resolve_release
      if [[ -n $ASSET_URL ]]; then
        msg_info "Downloading release $RELEASE_TAG"
        curl -fsSL "$ASSET_URL" -o "$work/app.tar.gz"
        tar -xzf "$work/app.tar.gz" -C "$work"
        cp -a "$work"/llama-paddock-dashboard/. "$STAGE"/
        INSTALLED_VERSION="$RELEASE_TAG"
        msg_ok "Release $RELEASE_TAG downloaded"
        return
      fi
      [[ $VERSION == latest ]] || die "release $VERSION not found or has no dashboard asset"
      msg_warn "No published release yet — building from the ${BRANCH} branch instead"
    fi
    msg_info "Downloading source (${BRANCH})"
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$work/src.tar.gz"
    tar -xzf "$work/src.tar.gz" -C "$work"
    src=$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -1)
    INSTALLED_VERSION="${BRANCH}@$(date +%Y%m%d)"
  fi

  msg_info "Building the dashboard (a minute or two)"
  local build="$work/build"
  mkdir -p "$build"
  cp -a "$src/dashboard/." "$build"/
  rm -rf "$build/node_modules" "$build/.next"
  ( cd "$build" && NEXT_TELEMETRY_DISABLED=1 npm ci --no-audit --no-fund --loglevel=error >/dev/null \
      && NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null ) || die "build failed (needs ~1.5 GB RAM; try a release build instead)"
  cp -a "$build/.next/standalone/." "$STAGE"/
  mkdir -p "$STAGE/.next"
  cp -a "$build/.next/static" "$STAGE/.next/static"
  msg_ok "Build complete"
}

write_config() {
  mkdir -p "$CFG_DIR"
  if [[ ! -f $CFG_DIR/config.yaml ]]; then
    cat > "$CFG_DIR/config.yaml" <<EOF
# llama-paddock config. Restart after editing: systemctl restart llama-paddock
poll_interval: 3        # seconds between polls of every host
history_points: 400     # samples kept in memory for sparklines

# Add hosts in the dashboard (Add host). Hosts listed here also work, but are
# read-only in the UI. Tokens can live in llama-paddock.env as \${VAR}.
# instances:
#   - id: ollama-01
#     name: ollama-01
#     ollama_url: http://192.168.30.101:11434
#     agent_url: http://192.168.30.101:11435
#     agent_token: \${AGENT_TOKEN_1}
EOF
    msg_ok "Wrote $CFG_DIR/config.yaml"
  else
    msg_ok "Keeping existing $CFG_DIR/config.yaml"
  fi

  if [[ ! -f $CFG_DIR/llama-paddock.env ]]; then
    ADMIN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')
    cat > "$CFG_DIR/llama-paddock.env" <<EOF
# llama-paddock service environment
PORT=${PORT}
HOSTNAME=0.0.0.0
PADDOCK_CONFIG=${CFG_DIR}/config.yaml
NEXT_TELEMETRY_DISABLED=1
# Initial login. You must change the password on first sign-in; after that it
# lives (hashed) in ${DATA_DIR}/auth.json and these two lines are ignored.
# Forgot it? rm ${DATA_DIR}/auth.json && systemctl restart llama-paddock
PADDOCK_USERNAME=admin
PADDOCK_PASSWORD=${ADMIN_PASSWORD}
# PADDOCK_AUTH=off disables the login, e.g. behind an auth proxy.
EOF
    msg_ok "Wrote $CFG_DIR/llama-paddock.env"
  fi
  chown -R root:"$SVC_USER" "$CFG_DIR"
  chmod 750 "$CFG_DIR"
  chmod 640 "$CFG_DIR"/config.yaml "$CFG_DIR"/llama-paddock.env
}

write_service() {
  cat > /etc/systemd/system/llama-paddock.service <<EOF
[Unit]
Description=llama-paddock dashboard
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${CFG_DIR}/llama-paddock.env
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=${APP_DIR} ${CFG_DIR}
# hosts added in the UI and the login live here (${DATA_DIR})
StateDirectory=llama-paddock
StateDirectoryMode=0700
Environment=PADDOCK_DATA_DIR=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

  cat > /usr/local/bin/update-llama-paddock <<EOF
#!/usr/bin/env bash
# Update llama-paddock to the latest release (pass a tag like v1.2.0 to pin one)
export PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_REPO="${REPO}" PADDOCK_BRANCH="${BRANCH}" PADDOCK_VERSION="\${1:-latest}"
exec bash -c "\$(curl -fsSL ${SELF_URL})"
EOF
  chmod 755 /usr/local/bin/update-llama-paddock
}

local_install() {
  [[ $EUID -eq 0 ]] || die "run as root"
  WORK=""; STAGE=""
  trap 'rm -rf "${WORK:-}"; [[ -n ${STAGE:-} && -d ${STAGE:-} ]] && rm -rf "$STAGE"; true' EXIT
  local updating=""
  [[ -f $APP_DIR/server.js ]] && updating=1

  [[ -n $updating ]] && msg_info "Existing install found ($(cat "$APP_DIR/VERSION" 2>/dev/null || echo unknown)) — updating, config is kept"

  ensure_deps
  id "$SVC_USER" &>/dev/null || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"

  fetch_app
  echo "$INSTALLED_VERSION" > "$STAGE/VERSION"

  local has_systemd=""
  [[ -d /run/systemd/system ]] && has_systemd=1
  [[ -n $has_systemd ]] && systemctl stop llama-paddock 2>/dev/null || true

  # swap in the new build
  rm -rf "${APP_DIR}.old"
  [[ -d $APP_DIR ]] && mv "$APP_DIR" "${APP_DIR}.old"
  mv "$STAGE" "$APP_DIR"
  chown -R root:"$SVC_USER" "$APP_DIR"
  chmod -R u=rwX,g=rX,o= "$APP_DIR"
  rm -rf "${APP_DIR}.old"
  msg_ok "Installed $INSTALLED_VERSION to $APP_DIR"

  write_config
  PORT=$(sed -n 's/^PORT=//p' "$CFG_DIR/llama-paddock.env" | tail -1); PORT=${PORT:-8080}
  write_service

  if [[ -n $has_systemd ]]; then
    systemctl daemon-reload
    systemctl enable --now llama-paddock >/dev/null 2>&1
    systemctl restart llama-paddock
    local ok=""
    for _ in $(seq 1 20); do
      curl -fsS "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1 && { ok=1; break; }
      sleep 1
    done
    [[ -n $ok ]] && msg_ok "Service llama-paddock is running" || msg_warn "Service not answering yet — check: journalctl -u llama-paddock"
  else
    msg_warn "systemd not running here; start it manually:"
    echo "     set -a; . ${CFG_DIR}/llama-paddock.env; set +a; node ${APP_DIR}/server.js"
  fi

  local ip; ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo "   ${C_B}llama-paddock ${INSTALLED_VERSION}${C_0}  →  http://${ip:-localhost}:${PORT}"
  if [[ -z $updating && -n ${ADMIN_PASSWORD-} ]]; then
    echo "   Login:   admin / ${ADMIN_PASSWORD}   (you'll choose a new password on first sign-in)"
  fi
  echo "   Config:  ${CFG_DIR}/config.yaml   then: systemctl restart llama-paddock"
  echo "   Update:  update-llama-paddock"
  echo
}

# ================================================================= main
[[ -n ${PADDOCK_NESTED-} ]] || header   # set when re-run inside the new CT from proxmox_install
if command -v pveversion >/dev/null 2>&1 && [[ -z ${PADDOCK_LOCAL-} ]]; then
  proxmox_install
else
  local_install
fi

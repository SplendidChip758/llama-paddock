#!/usr/bin/env bash
# llama-paddock Linux agent installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/agent.sh)"
#
# On a Proxmox VE host: lists your containers, you pick the Ollama LXC, and the
# agent is installed inside it (via pct exec).
# Inside the Ollama LXC/VM itself: installs the agent directly.
# Re-running it updates the agent and keeps its token.
# PADDOCK_UNINSTALL=1 removes it again (same as uninstall-llama-paddock-agent).
#
# Options (environment variables):
#   PADDOCK_VERSION      latest (default) | v1.2.3 | main  — which agent version to fetch
#   PADDOCK_REPO         GitHub repo (default: SplendidChip758/llama-paddock)
#   PADDOCK_BRANCH       branch used when there is no release yet (default: main)
#   PADDOCK_AGENT_TOKEN  reuse an existing token instead of generating one
#   PADDOCK_AGENT_PORT   default 11435
#   PADDOCK_CTID         Proxmox: container to install into (skips the prompt)
#   PADDOCK_LOCAL=1      install here even on a Proxmox host
#   PADDOCK_YES=1        non-interactive
#   PADDOCK_UNINSTALL=1  remove the agent instead (Ollama and its settings are left alone)
set -euo pipefail

REPO="${PADDOCK_REPO:-SplendidChip758/llama-paddock}"
BRANCH="${PADDOCK_BRANCH:-main}"
VERSION="${PADDOCK_VERSION:-latest}"
AGENT_PORT="${PADDOCK_AGENT_PORT:-11435}"
SELF_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}/install/agent.sh"
PREFIX=/opt/llama-paddock-agent
ENV_FILE=/etc/llama-paddock-agent.env
UNIT_FILE=/etc/systemd/system/llama-paddock-agent.service
NODE_MIN="18.15"

init_colors() {
  if [[ -t 1 ]]; then
    C_OK=$'\e[32m'; C_INFO=$'\e[36m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_B=$'\e[1m'; C_0=$'\e[0m'
  else
    C_OK=""; C_INFO=""; C_WARN=""; C_ERR=""; C_B=""; C_0=""
  fi
}
init_colors
msg_info() { echo -e " ${C_INFO}▸${C_0} $*"; }
msg_ok()   { echo -e " ${C_OK}✔${C_0} $*"; }
msg_warn() { echo -e " ${C_WARN}!${C_0} $*"; }
die()      { echo -e " ${C_ERR}✖ $*${C_0}" >&2; exit 1; }

# confirm "Question" [y|n] — y/n is the default answer; PADDOCK_YES answers yes
confirm() {
  local a="" def=${2:-y}
  [[ -n ${PADDOCK_YES-} ]] && return 0
  [[ -r /dev/tty ]] && { read -r -p "   $1 $([[ $def == y ]] && echo "[Y/n]" || echo "[y/N]"): " a </dev/tty || true; }
  [[ ${a:-$def} =~ ^[Yy] ]]
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

ask() {
  local __var=$1 __q=$2 __def=${3-} __ans=""
  if [[ -n ${!__var-} ]]; then return; fi
  if [[ -z ${PADDOCK_YES-} && -r /dev/tty ]]; then
    read -r -p "   ${__q}${__def:+ [${__def}]}: " __ans </dev/tty || true
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# PADDOCK_NESTED is set when re-run inside the CT from proxmox_install
[[ -n ${PADDOCK_NESTED-} ]] || cat <<EOF
${C_B}
   llama${C_WARN}paddock${C_0}${C_B}  ·  Linux agent installer${C_0}
   Runs next to Ollama: GPU + host stats, env editing, restart, logs

EOF

# ================================================================= Proxmox host
# pick_ct "Question" — list the node's containers and set CT_ID (PADDOCK_CTID skips the question)
pick_ct() {
  # pct exec passes the host's locale into the container, where it usually isn't
  # generated (perl/apt then warn on every call); C.UTF-8 exists in every template.
  export LANG=C.UTF-8; unset LANGUAGE "${!LC_@}"
  echo "   Containers on this node:"
  pct list | awk 'NR==1 {printf "     %s\n", $0; next} {printf "     %s\n", $0}'
  echo
  local guess; guess=$(pct list | awk 'NR>1 && tolower($0) ~ /ollama/ {print $1; exit}')
  CT_ID="${PADDOCK_CTID-}"
  ask CT_ID "$1" "$guess"
  [[ -n $CT_ID ]] || die "no container selected"
  pct status "$CT_ID" &>/dev/null || die "container $CT_ID does not exist on this node"
}

proxmox_install() {
  msg_info "Proxmox VE detected — the agent goes inside your Ollama container (PADDOCK_LOCAL=1 installs on the host instead)"
  echo
  pick_ct "Container ID of the Ollama LXC"
  if ! pct status "$CT_ID" | grep -q running; then
    msg_info "Starting container $CT_ID"
    pct start "$CT_ID"; sleep 3
  fi

  pct exec "$CT_ID" -- bash -c "command -v curl >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null)" \
    || die "could not install curl inside CT $CT_ID"
  pct exec "$CT_ID" -- env \
    PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_NESTED=1 PADDOCK_REPO="$REPO" PADDOCK_BRANCH="$BRANCH" PADDOCK_VERSION="$VERSION" \
    PADDOCK_AGENT_PORT="$AGENT_PORT" PADDOCK_AGENT_TOKEN="${PADDOCK_AGENT_TOKEN-}" \
    bash -c "curl -fsSL '$SELF_URL' | bash"

  local ip; ip=$(pct exec "$CT_ID" -- hostname -I 2>/dev/null | awk '{print $1}')
  echo
  msg_ok "Agent installed in CT ${CT_ID}.  In the dashboard, Add host with agent URL http://${ip:-<ct-ip>}:${AGENT_PORT}"
  echo "   Update later:  pct exec ${CT_ID} -- update-llama-paddock-agent"
  echo "   Uninstall:     pct exec ${CT_ID} -- uninstall-llama-paddock-agent"
}

proxmox_uninstall() {
  msg_info "Proxmox VE detected — removing the agent from one of your containers (PADDOCK_LOCAL=1 removes it from the host instead)"
  echo
  pick_ct "Container ID to remove the agent from"
  confirm "Remove the llama-paddock agent from CT ${CT_ID}? Ollama itself is not touched." n || die "cancelled, nothing was removed"
  local was_stopped=""
  if ! pct status "$CT_ID" | grep -q running; then
    was_stopped=1
    msg_info "Starting container $CT_ID"
    pct start "$CT_ID"; sleep 3
  fi
  # the installed uninstaller works offline; older installs don't have it, so fall back to this script
  pct exec "$CT_ID" -- env PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_NESTED=1 PADDOCK_UNINSTALL=1 bash -c \
    "if [[ -x /usr/local/bin/uninstall-llama-paddock-agent ]]; then exec /usr/local/bin/uninstall-llama-paddock-agent; fi
     curl -fsSL '$SELF_URL' | bash"
  if [[ -n $was_stopped ]]; then pct stop "$CT_ID"; fi
}

# ================================================================= local install
ensure_node() {
  local have=""
  command -v node >/dev/null && have=$(node -p 'process.versions.node')
  if [[ -n $have ]] && version_ge "$have" "$NODE_MIN"; then
    msg_ok "Node.js $have"; return
  fi
  command -v apt-get >/dev/null || die "Node.js >= $NODE_MIN is required (found: ${have:-none}); install it and re-run"
  msg_info "Installing Node.js${have:+ (found $have, need >= $NODE_MIN)}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null 2>&1 || true
  have=""; command -v node >/dev/null && have=$(node -p 'process.versions.node')
  if [[ -z $have ]] || ! version_ge "$have" "$NODE_MIN"; then
    msg_info "Distro Node.js too old — using NodeSource 22.x"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg >/dev/null
    quiet bash -o pipefail -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -" \
      || die "NodeSource setup failed"
    quiet env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs || die "could not install nodejs"
  fi
  msg_ok "Node.js $(node -p 'process.versions.node')"
}

# Where to get the agent files: a local checkout next to this script, or the repo at a ref
fetch_agent() {
  local tmp="$1"
  local here=""
  # only when run as a file from a clone (not via bash -c "$(curl ...)")
  [[ -f ${BASH_SOURCE[0]-} ]] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -n $here && -f $here/../agent/linux/paddock-agent.mjs ]]; then
    cp "$here/../agent/linux/paddock-agent.mjs" "$here/../agent/linux/llama-paddock-agent.service" "$tmp"/
    AGENT_REF="local checkout"
    return
  fi
  local ref="$VERSION"
  if [[ $ref == latest ]]; then
    ref=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tag_name||"")}catch{console.log("")}})') || ref=""
    [[ -n $ref ]] || { ref="$BRANCH"; msg_warn "No published release yet — using the ${BRANCH} branch"; }
  fi
  local base="https://raw.githubusercontent.com/${REPO}/${ref}/agent/linux"
  curl -fsSL "$base/paddock-agent.mjs" -o "$tmp/paddock-agent.mjs" || die "could not download the agent from $base"
  curl -fsSL "$base/llama-paddock-agent.service" -o "$tmp/llama-paddock-agent.service" || die "could not download the service unit"
  AGENT_REF="$ref"
}

# Remove what local_install put down. Ollama's own settings (override.conf and the
# .paddock-*.bak backups next to it) stay, so Ollama keeps running as configured.
local_uninstall() {
  [[ $EUID -eq 0 ]] || die "run as root"
  if [[ ! -e $UNIT_FILE && ! -d $PREFIX && ! -e $ENV_FILE ]]; then
    msg_ok "The llama-paddock agent is not installed on $(hostname)"
    return 0
  fi
  confirm "Remove the llama-paddock agent from $(hostname)?" n || die "cancelled, nothing was removed"
  systemctl disable --now llama-paddock-agent >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE" "$ENV_FILE" /usr/local/bin/update-llama-paddock-agent /usr/local/bin/uninstall-llama-paddock-agent
  rm -rf "$PREFIX"
  systemctl daemon-reload 2>/dev/null || true
  msg_ok "Agent removed from $(hostname)"
  echo "   Kept: Ollama's settings (ollama.service.d/override.conf) and Node.js."
  echo "   In the dashboard, remove this host, or edit it and clear the agent URL."
}

# uninstall-llama-paddock-agent: local_uninstall copied out of this script, so it works offline
write_uninstaller() {
  {
    echo '#!/usr/bin/env bash'
    echo '# Remove the llama-paddock agent from this machine (written by install/agent.sh; PADDOCK_YES=1 skips the question)'
    echo 'set -euo pipefail'
    declare -p PREFIX ENV_FILE UNIT_FILE
    declare -f init_colors msg_info msg_ok msg_warn die confirm local_uninstall
    echo 'init_colors'
    echo 'local_uninstall'
  } > /usr/local/bin/uninstall-llama-paddock-agent
  chmod 755 /usr/local/bin/uninstall-llama-paddock-agent
}

local_install() {
  [[ $EUID -eq 0 ]] || die "run as root"
  [[ -d /run/systemd/system ]] || die "systemd is required (this agent manages ollama.service)"
  command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null; }
  ensure_node

  if ! systemctl list-unit-files ollama.service &>/dev/null || ! systemctl cat ollama.service &>/dev/null; then
    msg_warn "ollama.service not found — the agent will still report stats, but env editing/restart need Ollama installed as a systemd service"
  fi
  command -v nvidia-smi >/dev/null || msg_warn "nvidia-smi not found — GPU stats will be unavailable"

  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "${TMP_DIR:-}"' EXIT
  local tmp="$TMP_DIR"
  fetch_agent "$tmp"

  mkdir -p "$PREFIX"
  install -m 0755 "$tmp/paddock-agent.mjs" "$PREFIX/paddock-agent.mjs"
  echo "$AGENT_REF" > "$PREFIX/VERSION"
  msg_ok "Agent ($AGENT_REF) installed to $PREFIX"

  local new_token=""
  if [[ ! -f $ENV_FILE ]]; then
    new_token="${PADDOCK_AGENT_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')}"
    cat > "$ENV_FILE" <<EOF
PADDOCK_AGENT_TOKEN=$new_token
PADDOCK_AGENT_BIND=0.0.0.0
PADDOCK_AGENT_PORT=$AGENT_PORT
PADDOCK_OLLAMA_UNIT=ollama.service
PADDOCK_OVERRIDE_PATH=/etc/systemd/system/ollama.service.d/override.conf
# extra mount points to report, comma separated (OLLAMA_MODELS is added automatically)
PADDOCK_DISK_PATHS=
EOF
    chmod 600 "$ENV_FILE"
  else
    msg_ok "Keeping existing $ENV_FILE (token unchanged)"
  fi

  sed "s#@NODE@#$(command -v node)#" "$tmp/llama-paddock-agent.service" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"

  cat > /usr/local/bin/update-llama-paddock-agent <<EOF
#!/usr/bin/env bash
# Update the llama-paddock agent (pass a tag like v1.2.0 to pin one)
export PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_REPO="${REPO}" PADDOCK_BRANCH="${BRANCH}" PADDOCK_VERSION="\${1:-latest}"
exec bash -c "\$(curl -fsSL ${SELF_URL})"
EOF
  chmod 755 /usr/local/bin/update-llama-paddock-agent
  write_uninstaller

  systemctl daemon-reload
  systemctl enable llama-paddock-agent >/dev/null 2>&1
  systemctl restart llama-paddock-agent
  local ok=""
  for _ in $(seq 1 10); do
    curl -fsS "http://127.0.0.1:$(sed -n 's/^PADDOCK_AGENT_PORT=//p' "$ENV_FILE")/health" >/dev/null 2>&1 && { ok=1; break; }
    sleep 1
  done
  [[ -n $ok ]] && msg_ok "Agent is running" || msg_warn "Agent not answering yet — check: journalctl -u llama-paddock-agent"

  local ip; ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo "   ${C_B}Add this host in the dashboard${C_0} (Add host):"
  echo "     Ollama URL:   http://${ip:-<this-host>}:11434"
  echo "     Agent URL:    http://${ip:-<this-host>}:${AGENT_PORT}"
  if [[ -n $new_token ]]; then
    echo "     Agent token:  ${C_B}${new_token}${C_0}"
  else
    echo "     Agent token:  (unchanged — see PADDOCK_AGENT_TOKEN in $ENV_FILE)"
  fi
  echo
  echo "   Restrict port ${AGENT_PORT} to the dashboard host, e.g.:  ufw allow from <dashboard-ip> to any port ${AGENT_PORT} proto tcp"
  echo "   Update later:  update-llama-paddock-agent"
  echo "   Uninstall:     uninstall-llama-paddock-agent"
  echo
}

if command -v pveversion >/dev/null 2>&1 && [[ -z ${PADDOCK_LOCAL-} ]]; then
  if [[ -n ${PADDOCK_UNINSTALL-} ]]; then proxmox_uninstall; else proxmox_install; fi
else
  if [[ -n ${PADDOCK_UNINSTALL-} ]]; then local_uninstall; else local_install; fi
fi

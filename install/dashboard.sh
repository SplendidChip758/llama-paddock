#!/usr/bin/env bash
# llama-paddock dashboard installer
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SplendidChip758/llama-paddock/main/install/dashboard.sh)"
#
# On a Proxmox VE host: creates a new LXC (latest Ubuntu LTS by default, or Debian)
# and installs the dashboard in it.
# Anywhere else (LXC, VM, bare metal; Debian/Ubuntu): installs the dashboard directly.
# Re-running it on an existing install updates it and keeps your config.
# PADDOCK_UNINSTALL=1 removes it again (on a Proxmox host: destroys the dashboard CT).
#
# Options (environment variables):
#   PADDOCK_VERSION   latest (default) | dev | v1.2.3 | source  — "dev" is the newest release
#                     including prereleases (see dashboard-dev.sh); "source" builds PADDOCK_BRANCH
#   PADDOCK_BRANCH    git branch for source builds and helper files (default: main)
#   PADDOCK_REPO      GitHub repo (default: SplendidChip758/llama-paddock)
#   PADDOCK_PORT      port to listen on (default: 8080)
#   PADDOCK_LOCAL=1   install here even on a Proxmox host
#   PADDOCK_YES=1     non-interactive: accept all defaults
#   PADDOCK_TARBALL   path to a prebuilt dashboard tarball (offline install)
#   PADDOCK_SOURCE_DIR path to a local checkout to build from
#   PADDOCK_TUI=0     plain text prompts instead of whiptail dialogs
#   PADDOCK_UNINSTALL=1  remove the dashboard instead (same as uninstall-llama-paddock)
#   PADDOCK_PURGE=1   with PADDOCK_UNINSTALL: also delete config, saved hosts and login
#   CT_OS, CT_ID, CT_PASSWORD, CT_ROOT_SSH, CT_SSH_KEY, CT_IP, …  preset the Proxmox settings
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
NODE_MIN="22.13"

# ---------------------------------------------------------------- ui helpers
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

header() {
  cat <<EOF
${C_B}
   llama${C_WARN}paddock${C_0}${C_B}  ·  dashboard installer${C_0}
   Monitor & manage your Ollama fleet — github.com/${REPO}

EOF
}

# ------------------------------------------------------------------ prompts
# Questions use whiptail dialogs when it's available and we have a terminal, otherwise
# plain text prompts (PADDOCK_TUI=0 forces text). PADDOCK_YES=1 asks nothing.
interactive() { [[ -z ${PADDOCK_YES-} && -r /dev/tty ]]; }
TUI=""
if interactive && [[ ${PADDOCK_TUI:-1} != 0 && ${TERM:-dumb} != dumb ]] && command -v whiptail >/dev/null; then TUI=1; fi
BACKTITLE="llama-paddock · dashboard installer"

# wt ARGS… — run whiptail on the terminal and print the answer; fails on Cancel/Esc
wt() { whiptail --backtitle "$BACKTITLE" "$@" 3>&1 1>&2 2>&3 </dev/tty; }
cancelled() { [[ -n $TUI ]] && clear; die "cancelled, nothing was created"; }
# notice "Message" — a message box, or a warning line in text mode
notice() { if [[ -n $TUI ]]; then wt --title " llama-paddock " --msgbox "$1" 10 68 || true; else msg_warn "$1"; fi; }

# ask VAR "Question" — free text; the current value of VAR is the default ("-" clears it in text mode)
ask() {
  local __var=$1 __q=$2 __ans=""
  interactive || return 0
  if [[ -n $TUI ]]; then
    __ans=$(wt --title " Advanced settings " --inputbox "$__q" 9 72 "${!__var-}") || cancelled
  else
    read -r -p "   ${__q}${!__var:+ [${!__var}]}: " __ans </dev/tty || true
    __ans=${__ans:-${!__var-}}
    [[ $__ans == - ]] && __ans=""
  fi
  printf -v "$__var" '%s' "$__ans"
}

# choose VAR "Question" tag "description" … — one of a fixed set; the current value of VAR is the default
choose() {
  local __var=$1 __q=$2 __ans="" __i __n __d __def=1 __tags=()
  shift 2
  interactive || return 0
  for ((__i = 1; __i <= $#; __i += 2)); do __tags+=("${!__i}"); done
  if [[ -n $TUI ]]; then
    __ans=$(wt --title " $__q " --default-item "${!__var-}" --menu "" $((${#__tags[@]} + 7)) 76 ${#__tags[@]} "$@") || cancelled
  else
    echo "   ${__q}:"
    for ((__i = 1; __i <= $#; __i += 2)); do
      __n=$(((__i + 1) / 2)); __d=$((__i + 1))
      printf '     %d) %-14s %s\n' "$__n" "${!__i}" "${!__d}"
      [[ ${!__i} == "${!__var-}" ]] && __def=$__n
    done
    while :; do
      read -r -p "   Choose [${__def}]: " __ans </dev/tty || true
      __ans=${__ans:-$__def}
      if [[ $__ans =~ ^[0-9]+$ ]] && ((__ans >= 1 && __ans <= ${#__tags[@]})); then __ans=${__tags[__ans - 1]}; break; fi
      for __i in "${__tags[@]}"; do [[ $__ans == "$__i" ]] && break 2; done
      msg_warn "Pick 1-${#__tags[@]}"
    done
  fi
  printf -v "$__var" '%s' "$__ans"
}

# ask_secret VAR "Question" — hidden input, typed twice; blank means none,
# or keeps the current value if VAR is already set ("-" then clears it)
ask_secret() {
  local __var=$1 __q=$2 __a="" __b="" __cur=${!1-}
  interactive || return 0
  [[ -n $__cur ]] && __q+=" (blank keeps the current one, - for none)"
  while :; do
    if [[ -n $TUI ]]; then
      __a=$(wt --title " Advanced settings " --passwordbox "$__q" 9 72) || cancelled
      [[ -z $__a ]] && break
      __b=$(wt --title " Advanced settings " --passwordbox "Type it again to confirm." 8 72) || cancelled
    else
      read -r -s -p "   ${__q}: " __a </dev/tty || true; echo >/dev/tty
      [[ -z $__a ]] && break
      read -r -s -p "   Confirm: " __b </dev/tty || true; echo >/dev/tty
    fi
    [[ $__a == "$__b" ]] && break
    notice "The passwords don't match, try again."
  done
  if [[ -z $__a ]]; then __a=$__cur; elif [[ $__a == - ]]; then __a=""; fi
  printf -v "$__var" '%s' "$__a"
}

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

# First host of the network an IP/CIDR is in, the usual gateway: 192.168.30.100/24 → 192.168.30.1.
# Prints nothing for input it can't use (dhcp, no prefix, /31, /32).
guess_gateway() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 0
  local -a o=("${BASH_REMATCH[@]:1:4}")
  local bits=${BASH_REMATCH[5]}
  (( bits >= 1 && bits <= 30 )) || return 0
  local x
  for x in "${o[@]}"; do (( 10#$x <= 255 )) || return 0; done
  local ip=$(( 10#${o[0]} << 24 | 10#${o[1]} << 16 | 10#${o[2]} << 8 | 10#${o[3]} ))
  local gw=$(( (ip & (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF) + 1 ))
  echo "$(( gw >> 24 & 255 )).$(( gw >> 16 & 255 )).$(( gw >> 8 & 255 )).$(( gw & 255 ))"
}

# A prerelease channel or tag (dev, v1.2.0-dev.3)
is_prerelease() { [[ $VERSION == dev || $VERSION == v*-* ]]; }
# What update-llama-paddock installs by default: stay on the channel this was installed from
CHANNEL=latest
[[ $VERSION == dev ]] && CHANNEL=dev

prerelease_notice() {
  local text="You are installing a PRERELEASE of llama-paddock (${VERSION}, from the ${BRANCH} branch).

Prereleases are built from every change merged to ${BRANCH}, before it is released as stable. They are for testing:
- features may be unfinished, change or be removed again,
- there may be bugs, including ones that lose metric history or saved settings,
- the data format may change, so going back to a stable release can mean waiting for the next one.

update-llama-paddock keeps this install on prereleases. To go back to stable, re-run the normal installer.
Please report problems at github.com/${REPO}/issues."
  if [[ -n ${PADDOCK_YES-} ]] || ! interactive; then
    msg_warn "Installing a prerelease (${VERSION}): for testing, may be unstable."
    return
  fi
  if [[ -n $TUI ]]; then
    wt --title " Prerelease " --defaultno --yes-button "Install" --no-button "Cancel" --yesno "$text" 22 78 || cancelled
  else
    echo -e "${C_WARN}${C_B}"
    echo "$text" | sed 's/^/   /'
    echo -e "${C_0}"
    confirm "Install the prerelease anyway?" n || die "cancelled, nothing was changed"
  fi
}

version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

# ================================================================= Proxmox host
# storage_items CONTENT — active storages that hold CONTENT (rootdir, vztmpl): "name" and
# "type · N GiB free" on alternate lines, ready for choose()
storage_items() {
  pvesm status -content "$1" 2>/dev/null \
    | awk 'NR > 1 && $3 == "active" { printf "%s\n%s · %.0f GiB free\n", $1, $2, $6 / 1048576 }'
}

bridge_items() {
  local b addr
  for b in $(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | sed 's/@.*//'); do
    addr=$(ip -4 -o addr show dev "$b" 2>/dev/null | awk '{print $4; exit}')
    printf '%s\n%s\n' "$b" "${addr:-bridge}"
  done
}

# choose_from VAR "Question" ITEMS-COMMAND… — choose() over a command's output, or free text if it lists nothing
choose_from() {
  local __v=$1 __q=$2 __items=()
  shift 2
  mapfile -t __items < <("$@")
  if ((${#__items[@]})); then choose "$__v" "$__q" "${__items[@]}"; else ask "$__v" "$__q"; fi
}

advanced_settings() {
  choose CT_OS "Distribution" ubuntu "Ubuntu, latest LTS" debian "Debian, latest stable"
  ask CT_ID "Container ID"
  ask CT_HOSTNAME "Hostname"
  ask CT_CORES "CPU cores"
  ask CT_RAM "Memory (MiB)"
  ask CT_DISK "Disk size (GiB)"
  choose_from CT_STORAGE "Storage for the root disk" storage_items rootdir
  choose_from CT_TSTORAGE "Storage for the CT template" storage_items vztmpl
  choose_from CT_BRIDGE "Network bridge" bridge_items
  ask CT_VLAN "VLAN tag (blank for none)"
  ask CT_IP "IPv4 address in CIDR (e.g. 192.168.30.100/24) or dhcp"
  if [[ $CT_IP == dhcp ]]; then
    CT_GW=""
  else
    # follow the IP's subnet unless a gateway was typed in by hand
    if [[ -z $CT_GW || $CT_GW == "${GW_GUESS-}" ]]; then CT_GW=$(guess_gateway "$CT_IP"); fi
    GW_GUESS=$CT_GW
    ask CT_GW "Gateway"
  fi
  ask_secret CT_PASSWORD "Root password (blank: none, use 'pct enter' from this host)"
  choose CT_ROOT_SSH "Root SSH login" \
    key      "Key only (the distro default)" \
    password "Key or root password" \
    off      "No root login over SSH"
  while [[ $CT_ROOT_SSH == password && -z $CT_PASSWORD ]]; do
    notice "Password SSH login needs a root password."
    ask_secret CT_PASSWORD "Root password"
  done
  if [[ $CT_ROOT_SSH != off ]]; then ask CT_SSH_KEY "SSH public key file for root (blank to skip)"; fi
}

# Validates the settings; in an interactive run shows the first problem and returns 1
check_settings() {
  local err=""
  bad() { [[ -n $err ]] || err=$1; }
  [[ $CT_OS == ubuntu || $CT_OS == debian ]] || bad "Unknown distribution '$CT_OS': use ubuntu or debian."
  if [[ $CT_ID =~ ^[0-9]+$ ]] && ((CT_ID >= 100)); then
    if pct status "$CT_ID" &>/dev/null; then bad "Container $CT_ID already exists."; fi
  else
    bad "Container ID must be a number of 100 or more."
  fi
  [[ $CT_HOSTNAME =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || bad "Hostname may only use letters, digits and '-'."
  [[ $CT_CORES =~ ^[0-9]+$ ]] && ((CT_CORES >= 1)) || bad "CPU cores must be a whole number."
  [[ $CT_RAM =~ ^[0-9]+$ ]] && ((CT_RAM >= 512)) || bad "Memory must be at least 512 MiB."
  [[ $CT_DISK =~ ^[0-9]+$ ]] && ((CT_DISK >= 4)) || bad "Disk size must be at least 4 GiB."
  [[ -z $CT_VLAN || ($CT_VLAN =~ ^[0-9]+$ && CT_VLAN -ge 1 && CT_VLAN -le 4094) ]] || bad "VLAN tag must be 1-4094, or blank."
  if [[ $CT_IP != dhcp ]]; then
    [[ -n $(guess_gateway "$CT_IP") ]] || bad "IP must look like 192.168.30.100/24 (prefix /1-/30), or be dhcp."
    [[ -z $CT_GW || $CT_GW =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || bad "Gateway must be an IPv4 address."
  fi
  case $CT_ROOT_SSH in
    key | off) ;;
    password) [[ -n $CT_PASSWORD ]] || bad "Root SSH login 'password' needs a root password." ;;
    *) bad "Root SSH login must be key, password or off." ;;
  esac
  [[ $CT_ROOT_SSH == off || -z $CT_SSH_KEY || -f $CT_SSH_KEY ]] || bad "SSH key file not found: $CT_SSH_KEY"
  unset -f bad

  [[ -z $err ]] && return 0
  interactive || die "$err"
  notice "$err"
  return 1
}

settings_summary() {
  local os="Ubuntu, latest LTS" net=$CT_IP root="no password (pct enter)"
  [[ $CT_OS == debian ]] && os="Debian, latest stable"
  [[ $CT_IP != dhcp ]] && net+=" via ${CT_GW:-no gateway}"
  [[ -n $CT_PASSWORD ]] && root="password set"
  root+=", SSH: ${CT_ROOT_SSH}"
  [[ $CT_ROOT_SSH != off && -n $CT_SSH_KEY ]] && root+=" + key"
  printf '%-14s %s\n' \
    "Distribution" "$os" \
    "Container" "$CT_ID ($CT_HOSTNAME)" \
    "CPU / RAM" "$CT_CORES cores / $CT_RAM MiB" \
    "Disk" "$CT_DISK GiB on $CT_STORAGE" \
    "Template" "stored on $CT_TSTORAGE" \
    "Network" "$net on $CT_BRIDGE${CT_VLAN:+, VLAN $CT_VLAN}" \
    "Root login" "$root" \
    "Dashboard" "port $PORT, version $VERSION"
}

# Shows the summary; 0 = create, 1 = change settings
confirm_settings() {
  if [[ -n $TUI ]]; then
    local rc=0
    whiptail --backtitle "$BACKTITLE" --title " Create the container? " --yes-button "Create" --no-button "Change" \
      --yesno "$(settings_summary)" 17 76 </dev/tty || rc=$?
    ((rc == 255)) && cancelled
    return "$rc"
  fi
  echo
  settings_summary | sed 's/^/   /'
  echo
  local a=""
  read -r -p "   Create the container with these settings? [Y/n]: " a </dev/tty || true
  echo
  [[ -z $a || $a =~ ^[Yy] ]]
}

proxmox_install() {
  msg_info "Proxmox VE detected — creating a new LXC for the dashboard (set PADDOCK_LOCAL=1 to install on the host instead)"
  echo
  # pct exec passes the host's locale into the container, where it usually isn't
  # generated (perl/apt then warn on every call); C.UTF-8 exists in every template.
  export LANG=C.UTF-8; unset LANGUAGE "${!LC_@}"

  # defaults; anything already set in the environment (CT_ID=…, CT_IP=…) wins
  CT_OS=${CT_OS:-ubuntu}
  CT_ID=${CT_ID:-$(pvesh get /cluster/nextid)}
  CT_HOSTNAME=${CT_HOSTNAME:-llama-paddock}
  CT_PASSWORD=${CT_PASSWORD-}
  CT_ROOT_SSH=${CT_ROOT_SSH:-key}
  CT_SSH_KEY=${CT_SSH_KEY-}
  CT_CORES=${CT_CORES:-2}
  CT_RAM=${CT_RAM:-1024}
  CT_DISK=${CT_DISK:-6}
  CT_STORAGE=${CT_STORAGE:-$(storage_items rootdir | sed -n 1p)}
  CT_STORAGE=${CT_STORAGE:-local-lvm}
  CT_TSTORAGE=${CT_TSTORAGE:-$(storage_items vztmpl | sed -n 1p)}
  CT_TSTORAGE=${CT_TSTORAGE:-local}
  CT_BRIDGE=${CT_BRIDGE:-vmbr0}
  CT_VLAN=${CT_VLAN-}
  CT_IP=${CT_IP:-dhcp}
  CT_GW=${CT_GW-}
  if [[ $CT_IP != dhcp && -z $CT_GW ]]; then CT_GW=$(guess_gateway "$CT_IP"); GW_GUESS=$CT_GW; fi
  CT_OS=${CT_OS,,}; CT_ROOT_SSH=${CT_ROOT_SSH,,}

  if interactive; then
    local mode=default
    choose mode "Setup mode" \
      default  "${CT_OS^} · ${CT_CORES} CPU · ${CT_RAM} MiB · ${CT_DISK} GiB · ${CT_IP} on ${CT_BRIDGE}" \
      advanced "Choose every setting"
    [[ $mode == advanced ]] && advanced_settings
    while :; do
      if ! check_settings; then advanced_settings; continue; fi
      confirm_settings && break
      advanced_settings
    done
    [[ -n $TUI ]] && { clear; header; }
  else
    check_settings
  fi

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

  local extra=()
  [[ -n $CT_SSH_KEY && $CT_ROOT_SSH != off ]] && extra+=(--ssh-public-keys "$CT_SSH_KEY")

  msg_info "Creating container $CT_ID ($CT_HOSTNAME)"
  pct create "$CT_ID" "${CT_TSTORAGE}:vztmpl/${template}" \
    --hostname "$CT_HOSTNAME" --cores "$CT_CORES" --memory "$CT_RAM" --swap 512 \
    --rootfs "${CT_STORAGE}:${CT_DISK}" --net0 "$net" \
    --unprivileged 1 --features nesting=1 --onboot 1 --ostype "$CT_OS" \
    --tags "llama-paddock" --description "llama-paddock dashboard — https://github.com/${REPO}" \
    "${extra[@]}" >/dev/null
  pct start "$CT_ID"
  msg_ok "Container $CT_ID started"

  # set via stdin rather than pct create --password, so it never shows up in the process list
  if [[ -n $CT_PASSWORD ]]; then
    printf 'root:%s\n' "$CT_PASSWORD" | pct exec "$CT_ID" -- chpasswd || die "could not set the root password"
    msg_ok "Root password set"
  fi

  # sshd reads the first value it finds, and sshd_config.d/ is included before the main file
  local permit
  case $CT_ROOT_SSH in key) permit=prohibit-password ;; password) permit=yes ;; off) permit=no ;; esac
  pct exec "$CT_ID" -- bash -c "[[ -d /etc/ssh/sshd_config.d ]] || exit 0
    printf '# set by the llama-paddock installer\nPermitRootLogin ${permit}\n' > /etc/ssh/sshd_config.d/10-llama-paddock.conf
    systemctl try-reload-or-restart ssh.service >/dev/null 2>&1 || true" || msg_warn "could not configure SSH"
  msg_ok "Root SSH login: ${CT_ROOT_SSH}"

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
  local how=()
  [[ -n $CT_PASSWORD ]] && how+=("console with your password")
  [[ $CT_ROOT_SSH == password ]] && how+=("ssh root@${ip:-<ct-ip>} with your password")
  [[ $CT_ROOT_SSH != off && -n $CT_SSH_KEY ]] && how+=("ssh root@${ip:-<ct-ip>} with your key")
  how+=("pct enter ${CT_ID} from this host")
  local joined; printf -v joined '%s, ' "${how[@]}"
  echo "   Root login:  ${joined%, }"
  echo "   Update later from the Proxmox host:  pct exec ${CT_ID} -- update-llama-paddock"
  echo "   Remove it:   PADDOCK_UNINSTALL=1 with the same one-liner on this host (destroys CT ${CT_ID})"
}

# The dashboard has its own CT (created by proxmox_install and tagged llama-paddock), so
# uninstalling from the host destroys that CT. Only tagged CTs are offered.
proxmox_uninstall() {
  msg_info "Proxmox VE detected — the dashboard runs in its own container, so uninstalling destroys it (PADDOCK_LOCAL=1 removes it from the host instead)"
  echo
  local preset=${CT_ID-} items=() f id name state
  for f in /etc/pve/lxc/*.conf; do
    [[ -f $f ]] && grep -Eq '^tags:.*\bllama-paddock\b' "$f" || continue
    id=$(basename "$f" .conf)
    name=$(sed -n 's/^hostname: //p' "$f")
    state=$(pct status "$id" 2>/dev/null | awk '{print $2}')
    items+=("$id" "${name:-?} (${state:-unknown})")
  done
  ((${#items[@]})) || die "no container tagged llama-paddock on this node; remove it with: pct destroy <ctid>"

  CT_ID=${preset:-${items[0]}}
  choose CT_ID "Dashboard container to destroy" "${items[@]}"
  local i found=""
  for ((i = 0; i < ${#items[@]}; i += 2)); do [[ ${items[i]} == "$CT_ID" ]] && found=1; done
  [[ -n $found ]] || die "CT $CT_ID is not a llama-paddock dashboard container"

  if interactive; then
    local typed=""
    ask typed "Type ${CT_ID} to destroy CT ${CT_ID} and everything in it (dashboard, saved hosts, login)"
    [[ -n $TUI ]] && clear
    [[ $typed == "$CT_ID" ]] || die "cancelled, nothing was removed"
  else
    [[ -n $preset ]] || die "set CT_ID=<ctid> to destroy a dashboard container non-interactively"
  fi

  if pct status "$CT_ID" | grep -q running; then
    msg_info "Stopping container $CT_ID"
    pct stop "$CT_ID"
  fi
  pct destroy "$CT_ID" --purge >/dev/null
  msg_ok "Container $CT_ID destroyed"
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
  case $VERSION in
    latest) api+="/latest" ;;
    dev) api+="?per_page=30" ;;  # newest first, prereleases included
    *) api+="/tags/${VERSION}" ;;
  esac
  local json; json=$(curl -fsSL -H "Accept: application/vnd.github+json" "$api" 2>/dev/null) || return 0
  read -r RELEASE_TAG ASSET_URL < <(node -e '
    let r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (Array.isArray(r)) r = r.find((x) => !x.draft) || {};
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
      [[ $VERSION == latest || $VERSION == dev ]] || die "release $VERSION not found or has no dashboard asset"
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
history_points: 400     # recent samples shown in sparklines
history_retention_days: 30  # metric history kept in /var/lib/llama-paddock

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
# Update llama-paddock to the newest ${CHANNEL} release (pass a tag like v1.2.0 to pin one)
export PADDOCK_LOCAL=1 PADDOCK_YES=1 PADDOCK_REPO="${REPO}" PADDOCK_BRANCH="${BRANCH}" PADDOCK_VERSION="\${1:-${CHANNEL}}"
exec bash -c "\$(curl -fsSL ${SELF_URL})"
EOF
  chmod 755 /usr/local/bin/update-llama-paddock
  write_uninstaller
}

# Remove the dashboard from this machine. Config, saved hosts and login stay unless you
# say so (or PADDOCK_PURGE=1), so a reinstall picks them up again.
local_uninstall() {
  [[ $EUID -eq 0 ]] || die "run as root"
  if [[ ! -d $APP_DIR && ! -e /etc/systemd/system/llama-paddock.service ]]; then
    msg_ok "The llama-paddock dashboard is not installed on $(hostname)"
    return 0
  fi
  confirm "Remove the llama-paddock dashboard from $(hostname)?" n || die "cancelled, nothing was removed"
  local purge=${PADDOCK_PURGE-}
  if [[ -z $purge && -z ${PADDOCK_YES-} ]] && confirm "Also delete its config, saved hosts and login (${CFG_DIR}, ${DATA_DIR})?" n; then
    purge=1
  fi

  systemctl disable --now llama-paddock >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/llama-paddock.service /usr/local/bin/update-llama-paddock /usr/local/bin/uninstall-llama-paddock
  rm -rf "$APP_DIR" "${APP_DIR}.old"
  systemctl daemon-reload 2>/dev/null || true
  if [[ -n $purge ]]; then
    rm -rf "$CFG_DIR" "$DATA_DIR"
    if id "$SVC_USER" &>/dev/null; then userdel "$SVC_USER" 2>/dev/null || true; fi
    msg_ok "Dashboard, config and data removed from $(hostname)"
  else
    msg_ok "Dashboard removed from $(hostname)"
    echo "   Kept ${CFG_DIR} and ${DATA_DIR} (settings, saved hosts, login); a reinstall picks them up."
    echo "   To delete them too:  PADDOCK_PURGE=1 uninstall-llama-paddock  (or rm -rf both)"
  fi
  echo "   Node.js was left installed."
}

# uninstall-llama-paddock: local_uninstall copied out of this script, so it works offline
write_uninstaller() {
  {
    echo '#!/usr/bin/env bash'
    echo '# Remove the llama-paddock dashboard from this machine (written by install/dashboard.sh)'
    echo '# PADDOCK_YES=1 skips the questions; PADDOCK_PURGE=1 also deletes config, saved hosts and login.'
    echo 'set -euo pipefail'
    declare -p APP_DIR CFG_DIR DATA_DIR SVC_USER
    declare -f init_colors msg_info msg_ok msg_warn die confirm local_uninstall
    echo 'init_colors'
    echo 'local_uninstall'
  } > /usr/local/bin/uninstall-llama-paddock
  chmod 755 /usr/local/bin/uninstall-llama-paddock
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
  echo "   Remove:  uninstall-llama-paddock"
  echo
}

# ================================================================= main
[[ -n ${PADDOCK_NESTED-} ]] || header   # set when re-run inside the new CT from proxmox_install
# once, before anything is changed (the copy re-run inside a new CT skips it)
if [[ -z ${PADDOCK_NESTED-} && -z ${PADDOCK_UNINSTALL-} ]] && is_prerelease; then prerelease_notice; fi
if command -v pveversion >/dev/null 2>&1 && [[ -z ${PADDOCK_LOCAL-} ]]; then
  if [[ -n ${PADDOCK_UNINSTALL-} ]]; then proxmox_uninstall; else proxmox_install; fi
else
  if [[ -n ${PADDOCK_UNINSTALL-} ]]; then local_uninstall; else local_install; fi
fi

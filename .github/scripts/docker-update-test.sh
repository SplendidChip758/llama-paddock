#!/usr/bin/env bash
# CI (ci.yml, docker-update): the Docker update and rollback steps in docs/operations.md, run for
# real. A published image runs on a data volume and changes its data; a pre-update backup is taken
# with paddock-backup; the image built from the PR takes over the volume and must come up with that
# data. Then the rollback: the old image again, with the backup restored, and the change made after
# the backup gone.
#
#   docker-update-test.sh OLD_IMAGE NEW_IMAGE
set -euo pipefail
old=$1 new=$2
name=paddock-update-test vol=paddock-update-test port=18080
url=http://127.0.0.1:$port
jar=$(mktemp)

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$vol" >/dev/null 2>&1 || true
  rm -f "$jar"
}
trap cleanup EXIT
cleanup
docker volume create "$vol" >/dev/null

version_of() { docker run --rm "$1" node -p 'require("/app/package.json").version'; }

start() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:$port:8080" -v "$vol:/data" \
    -e PADDOCK_USERNAME=admin -e PADDOCK_PASSWORD=initial-password-1 "$1" >/dev/null
  local body=""
  for _ in $(seq 1 60); do
    body=$(curl -fsS "$url/api/healthz" 2>/dev/null) && [[ $body == *"\"version\":\"$2\""* ]] && return 0
    sleep 1
  done
  docker logs "$name" 2>&1 | tail -30
  echo "::error::$1 didn't come up as $2 (last answer: ${body:-none})"
  exit 1
}

# login PASSWORD — signs in; fails when the password is wrong
login() {
  rm -f "$jar"
  curl -fsS -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$1\"}" "$url/api/auth/login" >/dev/null 2>&1
}
set_password() {
  curl -fsS -b "$jar" -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"current\":\"$1\",\"password\":\"$2\"}" "$url/api/auth/password" >/dev/null
}

old_v=$(version_of "$old")
new_v=$(version_of "$new")
echo "updating $old ($old_v) to $new ($new_v)"

start "$old" "$old_v"
login initial-password-1
set_password initial-password-1 password-before-update
echo "✔ $old_v is running, with a changed password"

# docs: docker compose exec llama-paddock paddock-backup backup --reason pre-update
backup=$(docker exec "$name" paddock-backup backup --reason pre-update --json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).name')
echo "✔ pre-update backup $backup"

# docs: docker compose pull && docker compose up -d
start "$new" "$new_v"
login password-before-update || { echo "::error::the updated dashboard lost the data"; exit 1; }
set_password password-before-update password-after-update
echo "✔ $new_v is running on the same data"

# docs: pin the old image, docker compose stop, docker compose run --rm llama-paddock paddock-backup restore <name>, docker compose up -d
docker stop "$name" >/dev/null
docker run --rm -v "$vol:/data" "$old" paddock-backup restore "$backup"
start "$old" "$old_v"
login password-before-update || { echo "::error::the rollback didn't restore the backup"; exit 1; }
if login password-after-update; then echo "::error::a change made after the backup survived the rollback"; exit 1; fi
echo "✔ rolled back to $old_v with the backup restored"

#!/bin/sh
# Pull the latest code and rebuild the compose stack. Run it on the homelab, or from any machine
# with KIAI_DEPLOY_HOST set to ssh into the homelab and run it there.
# Usage: scripts/redeploy-server.sh [profile...]      e.g. scripts/redeploy-server.sh nvidia tunnel
#   Profiles default to COMPOSE_PROFILES (from the environment or .env), else to the profiles of
#   the containers already running, so a plain redeploy keeps the render worker and tunnel up.
#   KIAI_DEPLOY_HOST   ssh destination, e.g. daniel@192.168.1.88
#   KIAI_DEPLOY_DIR    the checkout on that host (default: ~/kiai)
#   KIAI_NO_PULL=1     rebuild the checkout as it is
set -eu

if [ -n "${KIAI_DEPLOY_HOST:-}" ]; then
  DIR="${KIAI_DEPLOY_DIR:-kiai}"
  echo "Redeploying on $KIAI_DEPLOY_HOST:$DIR"
  # shellcheck disable=SC2029 # expanded locally on purpose
  exec ssh -t "$KIAI_DEPLOY_HOST" \
    "cd $DIR && KIAI_NO_PULL=${KIAI_NO_PULL:-} sh scripts/redeploy-server.sh $*"
fi

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env here: cp .env.example .env and fill it in first." >&2
  exit 1
fi

if [ -z "${KIAI_NO_PULL:-}" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "The checkout has uncommitted changes; commit or stash them (or set KIAI_NO_PULL=1)." >&2
    exit 1
  fi
  git pull --ff-only
fi

if [ $# -gt 0 ]; then
  COMPOSE_PROFILES="$(echo "$*" | tr ' ' ',')"
  export COMPOSE_PROFILES
elif [ -z "${COMPOSE_PROFILES:-}" ] && ! grep -q '^COMPOSE_PROFILES=' .env; then
  # Map the running profile-only services back to their profiles.
  running="$(docker compose ps --services --status running 2>/dev/null || true)"
  profiles=""
  for svc in $running; do
    case "$svc" in
      render) profiles="$profiles,nvidia" ;;
      render-cpu) profiles="$profiles,cpu" ;;
      caddy | cloudflared) case "$profiles" in *tunnel*) ;; *) profiles="$profiles,tunnel" ;; esac ;;
    esac
  done
  COMPOSE_PROFILES="${profiles#,}"
  export COMPOSE_PROFILES
fi

echo "Rebuilding (profiles: ${COMPOSE_PROFILES:-none})"
docker compose up -d --build --wait --wait-timeout 180
docker image prune -f >/dev/null
docker compose ps

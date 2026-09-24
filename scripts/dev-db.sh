#!/bin/sh
# Local PostgreSQL for development and tests, in a container on port 55432.
# Usage: scripts/dev-db.sh up|down
set -eu

ENGINE="${CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then ENGINE=podman
  else echo "Install docker or podman (or set TEST_DATABASE_URL to an existing database)." >&2; exit 1
  fi
fi
NAME=kiai-postgres

case "${1:-up}" in
  up)
    if ! "$ENGINE" container inspect "$NAME" >/dev/null 2>&1; then
      "$ENGINE" run -d --name "$NAME" -p 55432:5432 \
        -e POSTGRES_USER=kiai -e POSTGRES_PASSWORD=kiai -e POSTGRES_DB=kiai \
        -v kiai-pgdata:/var/lib/postgresql/data docker.io/library/postgres:17-alpine
    else
      "$ENGINE" start "$NAME" >/dev/null
    fi
    until "$ENGINE" exec "$NAME" pg_isready -U kiai >/dev/null 2>&1; do sleep 1; done
    "$ENGINE" exec "$NAME" psql -U kiai -tAc "select 1 from pg_database where datname = 'kiai_test'" | grep -q 1 \
      || "$ENGINE" exec "$NAME" psql -U kiai -c "create database kiai_test" >/dev/null
    echo "PostgreSQL ready: postgres://kiai:kiai@localhost:55432/kiai (tests use kiai_test)"
    ;;
  down)
    "$ENGINE" stop "$NAME" >/dev/null && echo "stopped $NAME (data kept in volume kiai-pgdata)"
    ;;
  *)
    echo "usage: $0 up|down" >&2; exit 2
    ;;
esac

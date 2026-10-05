#!/bin/sh
# Rebuild the client from this checkout, install it over the current kiai binary, and restart
# the replay watcher if it's running. Run it on the PC you play on.
# Usage: scripts/redeploy-client.sh [--pull]
#   --pull     git pull --ff-only first
#   KIAI_BIN   where to install (default: the kiai on PATH, else ~/.local/bin/kiai)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  --pull) git -C "$ROOT" pull --ff-only ;;
  "") ;;
  *) echo "usage: $0 [--pull]" >&2; exit 2 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 GOARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 GOARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BIN="${KIAI_BIN:-$(command -v kiai 2>/dev/null || echo "$HOME/.local/bin/kiai")}"
VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)"

echo "Building kiai $VERSION for linux/$GOARCH"
OUT="dist/kiai-linux-$ARCH"
(
  cd "$ROOT/client"
  CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -trimpath \
    -ldflags "-s -w -X github.com/dblopez04/kiai/client/internal/cli.version=$VERSION" \
    -o "$OUT" ./cmd/kiai
)

# install unlinks the old file first, so this works while the watcher is running it.
mkdir -p "$(dirname "$BIN")"
install -m755 "$ROOT/client/$OUT" "$BIN"
echo "Installed $BIN ($("$BIN" --version))"

if systemctl --user is-active --quiet kiai-watch 2>/dev/null; then
  systemctl --user restart kiai-watch
  echo "Restarted kiai-watch (journalctl --user -u kiai-watch -f)"
fi

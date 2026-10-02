#!/bin/zsh
#
# launchd entry point for pi-web-shell.
#
# launchd does not read your shell profile, so PATH is minimal and `node` /
# `pi` are not on it. Resolve the Node installation here instead of hardcoding
# a version, so upgrading Node through nvm does not break the agent.
#
set -eu

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# Preferred: let nvm set up PATH for the default alias.
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

# Fallback: nvm's default alias pinned to a directory, for when nvm.sh is
# missing or refuses to run in a non-interactive shell.
if [ -r "$NVM_DIR/alias/default" ]; then
  DEFAULT_VERSION="$(cat "$NVM_DIR/alias/default")"
  if [ -d "$NVM_DIR/versions/node/$DEFAULT_VERSION/bin" ]; then
    PATH="$NVM_DIR/versions/node/$DEFAULT_VERSION/bin:$PATH"
  fi
fi
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[pi-web-shell] node not found on PATH=$PATH" >&2
  echo "[pi-web-shell] fix scripts/launchd-run.sh or install Node 22.19+" >&2
  exit 127
fi

echo "[pi-web-shell] starting with $(command -v node) ($(node --version))"
exec node --env-file-if-exists=.env src/server/index.ts

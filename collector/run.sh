#!/usr/bin/env bash
# Runs a Watchtower collector script from cron with the host's settings, on the latest merged code.
#
#   collector/run.sh sync_watchtower.py --only velocity,agents    # collect, commit data/, push
#   collector/run.sh judge.py run --ssh-host agent2 --concurrency 1
#
# Settings come from ~/.config/fgl-watchtower/collector.env (override with WATCHTOWER_ENV). It must set
# WATCHTOWER_REPO_DIR: a clone used only by the collector, never one you develop in, because the collector
# pulls, commits and pushes there. Runs are serialised with a lock, so a slow run is never doubled up.
set -euo pipefail
ENV_FILE="${WATCHTOWER_ENV:-$HOME/.config/fgl-watchtower/collector.env}"
[ -r "$ENV_FILE" ] || { echo "run.sh: no settings at $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${WATCHTOWER_REPO_DIR:?set WATCHTOWER_REPO_DIR in $ENV_FILE}"
script="$1"; shift
lock="${XDG_RUNTIME_DIR:-/tmp}/fgl-watchtower-${script%.py}.lock"
exec 9>"$lock"
flock -n 9 || { echo "run.sh: $script is already running" >&2; exit 0; }
cd "$WATCHTOWER_REPO_DIR"
# Pick up merged collector changes before running. Only fast-forwards: the collector's own data commits are
# pushed right away, so this clone never diverges.
git pull --ff-only -q || echo "run.sh: git pull failed; running the code already here" >&2
exec /usr/bin/python3 -I "collector/$script" "$@"

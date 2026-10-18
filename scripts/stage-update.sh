#!/usr/bin/env bash
# Builds Hangar for Linux or macOS and stages it as a pending update, without touching the running
# app -- the counterpart of stage-update.ps1, minus its "what's new" notes and its check for commits the
# installed build has and this one doesn't. The running app watches the staging folder and offers the
# update in its UI; installing it hands off to apply-update.sh.
#
# Usage:  scripts/stage-update.sh [--skip-build] [rid] [staging dir]
#   staging dir defaults to the app's own: ~/.local/share/Hangar/updates (Linux),
#   ~/Library/Application Support/Hangar/updates (macOS) -- Update:StagingPath's default there.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
skip_build=
if [ "${1:-}" = "--skip-build" ]; then skip_build=1; shift; fi
rid=${1:-}
if [ "$(uname -s)" = Darwin ]; then
  data="$HOME/Library/Application Support"
else
  data=${XDG_DATA_HOME:-$HOME/.local/share}
fi
# The running app's own staging folder: <data>/Hangar once a build from after the rename has run (it
# makes that folder on start), <data>/ClaudeWeb before then -- which is where an older build looks.
if [ -d "$data/Hangar" ] || [ ! -d "$data/ClaudeWeb" ]; then
  staging=${2:-$data/Hangar/updates}
else
  staging=${2:-$data/ClaudeWeb/updates}
fi

[ -n "$skip_build" ] || bash "$root/scripts/build.sh" ${rid:+"$rid"}
[ -f "$root/publish/Hangar" ] || { echo "No Hangar build in $root/publish." >&2; exit 1; }

# Built beside the payload and swapped in at the end, so the app never sees a half-copied update.
mkdir -p "$staging"
rm -rf "$staging/payload.tmp"
cp -Rp "$root/publish" "$staging/payload.tmp"
rm -rf "$staging/payload.old"
[ -d "$staging/payload" ] && mv "$staging/payload" "$staging/payload.old"
mv "$staging/payload.tmp" "$staging/payload"
rm -rf "$staging/payload.old"

echo "==> Staged $(sed -n 's/.*"buildId": *"\([^"]*\)".*/\1/p' "$staging/payload/build.json") in $staging/payload"
echo "    The running app offers it under the Update button in its sidebar."

#!/usr/bin/env bash
# Builds Hangar for another machine and stages it there as a pending update, over ssh -- for a Linux or
# macOS node (a home server, a laptop) that has no .NET SDK or Node of its own. The build is made here, the
# payload is copied into the node's own staging folder, and the node then offers it under its Update
# button: on itself, and on its heading in the sidebar of every node paired with it. Nothing on the
# node is stopped or restarted.
#
# Usage:  scripts/stage-update-remote.sh [--skip-build] [--notes FILE | --no-notes] [--allow-dropping-commits]
#                                        <ssh host> [rid]
#   The host is anything ssh takes (an alias from ~/.ssh/config). The rid (see build.sh) is the node's own,
#   read from it: one that doesn't match the node is refused -- an update it can't run would take it down,
#   with no SDK there to build another.
#   --notes FILE   "what's new" for the update dialog, in stage-update.ps1's format: the first plain line
#                  is the summary, "- " lines are the changes.
#   Without notes, the commit subjects between the node's installed build and this one are carried instead;
#   --no-notes carries none.
#   --allow-dropping-commits   stage it even though the build installed there has commits this one lacks
#                  (stage-update.ps1 refuses that the same way: it is how a feature quietly disappears).
#
# The counterpart of stage-update.sh (which stages on the machine it runs on) and stage-update.ps1.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
skip_build=
notes_file=
no_notes=
allow_dropping=
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) skip_build=1; shift ;;
    --notes) notes_file=${2:?--notes needs a file}; shift 2 ;;
    --no-notes) no_notes=1; shift ;;
    --allow-dropping-commits) allow_dropping=1; shift ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
host=${1:?usage: scripts/stage-update-remote.sh [--skip-build] [--notes FILE | --no-notes] [--allow-dropping-commits] <ssh host> [rid]}
rid=${2:-}
[ -z "$notes_file" ] || [ -f "$notes_file" ] || { echo "Notes file not found: $notes_file" >&2; exit 1; }

# What the node is, where it stages updates, and the commit installed there -- worked out on the node, the
# way stage-update.sh and install-unix.sh find them there. Through sh, whatever the login shell is.
remote_info=$(ssh -o BatchMode=yes "$host" 'sh -s' <<'SH'
uname -sm
if [ "$(uname -s)" = Darwin ]; then data="$HOME/Library/Application Support"; else data=${XDG_DATA_HOME:-$HOME/.local/share}; fi
# The node's default staging folder, as stage-update.sh decides it.
echo "$data/Hangar/updates"
f="$HOME/.local/opt/hangar/build.json"
[ -f "$f" ] && sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$f" | head -1
exit 0
SH
)
machine=$(printf '%s\n' "$remote_info" | sed -n 1p)
staging=$(printf '%s\n' "$remote_info" | sed -n 2p)
installed=$(printf '%s\n' "$remote_info" | sed -n 3p)
[ -n "$staging" ] || { echo "Could not work out the staging folder on $host." >&2; exit 1; }
case "$staging" in *"'"*) echo "The staging folder on $host has a quote in it: $staging" >&2; exit 1 ;; esac

case "$machine" in
  "Linux x86_64") native=linux-x64 ;;
  "Linux aarch64" | "Linux arm64") native=linux-arm64 ;;
  "Darwin arm64") native=osx-arm64 ;;
  "Darwin x86_64") native=osx-x64 ;;
  *) echo "$host is '$machine': not a machine a Hangar build is made for." >&2; exit 1 ;;
esac
rid=${rid:-$native}
[ "$rid" = "$native" ] || { echo "$host is $native, not $rid: it couldn't run that build." >&2; exit 1; }

# The commit this staging is: HEAD when it builds, the stamp's when it takes ./publish as it is.
commit=HEAD
if [ -n "$skip_build" ]; then
  [ -f "$root/publish/build.json" ] || { echo "No build in $root/publish (run build.sh $rid)." >&2; exit 1; }
  built=$(sed -n 's/.*"runtime": *"\([^"]*\)".*/\1/p' "$root/publish/build.json" | head -1)
  [ "$built" = "$rid" ] || { echo "The build in $root/publish is for '${built:-unknown}', and $host is $rid." >&2; exit 1; }
  commit=$(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$root/publish/build.json" | head -1)
fi

# Not past commits the node already has: they would go with this update, and nothing would say so.
if [ -n "$installed" ] && [ -z "$allow_dropping" ]; then
  if ! git -C "$root" cat-file -e "$installed^{commit}" 2> /dev/null; then
    echo "$host runs $installed, which this checkout doesn't have; fetch it, or pass --allow-dropping-commits." >&2
    exit 1
  fi
  if ! git -C "$root" merge-base --is-ancestor "$installed" "$commit"; then
    echo "$host runs $installed, which has commits this build ($commit) doesn't:" >&2
    git -C "$root" log --oneline "$commit..$installed" | head -10 >&2
    echo "Merge them in, or pass --allow-dropping-commits." >&2
    exit 1
  fi
fi

[ -n "$skip_build" ] || bash "$root/scripts/build.sh" "$rid"
[ -f "$root/publish/Hangar" ] || { echo "No Linux/macOS Hangar build in $root/publish (run build.sh $rid)." >&2; exit 1; }

# The payload as it goes over: the build, with the notes written into its own build.json -- the file the
# node's updater already reads, as stage-update.ps1 does it. Node is at hand: build.sh needs it.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -Rp "$root/publish" "$work/payload"
subjects=
if [ -z "$no_notes" ] && [ -z "$notes_file" ] && [ -n "$installed" ]; then
  subjects=$(git -C "$root" log --no-merges --pretty=format:%s "$installed..$commit" 2> /dev/null | head -40 || true)
fi
NOTES_FILE="$notes_file" NO_NOTES="$no_notes" SUBJECTS="$subjects" SINCE="$installed" node - "$work/payload/build.json" <<'JS'
const fs = require("fs");
const path = process.argv[2];
const stamp = JSON.parse(fs.readFileSync(path, "utf8").replace(/^﻿/, ""));
let notes = null;
if (!process.env.NO_NOTES) {
  if (process.env.NOTES_FILE) {
    let summary = null;
    const changes = [];
    for (const raw of fs.readFileSync(process.env.NOTES_FILE, "utf8").split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      const bullet = t.match(/^[-*]\s+(.*)$/);
      if (bullet) changes.push(bullet[1].trim());
      else if (!summary && !t.startsWith("#")) summary = t;
    }
    notes = { summary, changes };
  } else if (process.env.SUBJECTS) {
    notes = { summary: null, changes: process.env.SUBJECTS.split("\n").filter(Boolean) };
  }
}
if (notes && (notes.summary || notes.changes.length)) {
  notes.since = process.env.SINCE || null;
  stamp.notes = notes;
  fs.writeFileSync(path, JSON.stringify(stamp, null, 2));
  console.log(`    What's new: ${notes.changes.length} changes${notes.summary ? " -- " + notes.summary : ""}`);
}
JS

# Copied beside the live payload and swapped in at the end, as stage-update.sh does it, so the node's
# updater never sees half an update. A build made on Windows has no executable bits to carry over, and one
# for a Mac made anywhere but a Mac is unsigned, which Apple silicon refuses to run: both are put right on
# the node, as install-unix.sh does it, so the payload is a runnable build. Run through sh with the folder
# as its argument -- not the login shell, which may be fish -- and with stdin left to the tar stream.
swap='set -e
S=$1
mkdir -p "$S"
rm -rf "$S/payload.in" "$S/payload.tmp"
mkdir "$S/payload.in"
tar -C "$S/payload.in" -xf -
mv "$S/payload.in/payload" "$S/payload.tmp"
rmdir "$S/payload.in"
chmod +x "$S/payload.tmp/Hangar" "$S/payload.tmp/Hangar.PtyHost"
if [ "$(uname -s)" = Darwin ]; then
  xattr -dr com.apple.quarantine "$S/payload.tmp" 2> /dev/null || true
  codesign --force --sign - "$S/payload.tmp/Hangar" "$S/payload.tmp/Hangar.PtyHost"
fi
rm -rf "$S/payload.old"
if [ -d "$S/payload" ]; then mv "$S/payload" "$S/payload.old"; fi
mv "$S/payload.tmp" "$S/payload"
rm -rf "$S/payload.old"'
tar -C "$work" -cf - payload | ssh -o BatchMode=yes "$host" "sh -c '$(printf '%s' "$swap" | sed "s/'/'\\\\''/g")' sh '$staging'"

build_id=$(sed -n 's/.*"buildId": *"\([^"]*\)".*/\1/p' "$work/payload/build.json" | head -1)
echo "==> Staged $build_id on $host in $staging/payload${installed:+ (installed there: $installed)}"
echo "    $host offers it under its Update button -- and on its heading in a paired node's sidebar."

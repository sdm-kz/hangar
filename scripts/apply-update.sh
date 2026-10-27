#!/bin/sh
# Installs a staged update over a Hangar install folder and restarts the daemon -- the Linux and
# macOS counterpart of apply-update.ps1. Read that file's header first: the design is the same.
#
#   1. wait for the daemon's process to exit (it is stopping itself); force it down if it hangs
#   2. replace each top-level entry of <target> with the staged one (wwwroot as a whole), keeping the
#      installed appsettings*.json and anything else <target> has that the build does not
#   3. start the daemon again the same way it was running (systemd unit, launchd job, or process)
#
# Running sessions are NOT interrupted: each one lives in its own Hangar.PtyHost, launched from a
# per-build copy under the app's data folder, so nothing here touches them -- and nothing here may
# match processes by name, which would catch the hosts too.
#
# Every entry is replaced by a rename, never written over in place: a binary something still has open
# (or is executing) is then left intact for whoever holds it, instead of failing with "text file busy"
# or being changed underneath them.
#
# The daemon embeds this file and extracts it outside the install folder before running it, as:
#   apply-update.sh <staging> <target> <pid> <process|systemd|launchd> <service name> <wait seconds>
# On any failure it still tries to start whatever is in <target> back up.

staging=$1
target=$2
pid=$3
mode=${4:-process}
service=$5
wait_seconds=${6:-45}

# The script is extracted to <data>/Hangar/update; the daemon's logs sit beside that folder.
data_dir=$(cd "$(dirname "$0")/.." 2> /dev/null && pwd) || data_dir=${TMPDIR:-/tmp}
log_dir="$data_dir/logs"
mkdir -p "$log_dir"
log="$log_dir/update.log"
# Everything into the log, cp's and mv's own errors included. The daemon closes the pipes it started
# us with as it exits, and a write to one of those would be lost at best.
exec < /dev/null >> "$log" 2>&1

say() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

start_app() {
  case "$mode" in
    systemd)
      say "Starting systemd unit '$service'"
      systemctl --user start "$service"
      ;;
    launchd)
      say "Starting launchd job '$service'"
      # The timeout path below unloads the job; load it again from its plist when it is not there.
      # bootout returns before the job is fully gone, so a bootstrap straight after it can fail.
      launchctl kickstart "gui/$(id -u)/$service" && return 0
      for _ in 1 2 3 4 5; do
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$service.plist" && return 0
        sleep 1
      done
      return 1
      ;;
    *)
      say "Launching $target/Hangar (daemon, resuming sessions)"
      # --resume-sessions: this launch must resume even if the installed appsettings.json turned
      # Sessions:ResumeOnStart off.
      (cd "$target" && nohup "$target/Hangar" --resume-sessions > /dev/null 2>&1 &)
      ;;
  esac
}

fail() {
  say "FAILED: $*"
  # Never leave the machine without a running app: whatever is in $target now (the old build if the
  # copy never started, the new one if it finished) is what comes back.
  if start_app; then say "Restarted the app after the failure"; else say "Could not restart the app"; fi
  exit 1
}

# Replace one top-level entry of the install with the staged one: copy it in under a temporary name,
# then rename it over the old one.
replace() {
  src="$staging/$1"
  dst="$target/$1"
  tmp="$target/.$1.update-$$"
  rm -rf "$tmp"
  cp -Rp "$src" "$tmp" || return 1
  # A link would have the copy moved into whatever it points at, rather than put in its place.
  if [ -L "$dst" ]; then rm -f "$dst" || return 1; fi
  if [ -d "$dst" ]; then
    # rename(2) won't put a directory over a non-empty one; move the old one aside first.
    rm -rf "$dst.old-$$"
    mv "$dst" "$dst.old-$$" || return 1
    mv "$tmp" "$dst" || return 1
    rm -rf "$dst.old-$$"
  else
    mv -f "$tmp" "$dst" || return 1
  fi
}

say "=== apply-update: $staging -> $target (mode=$mode, pid=$pid) ==="

[ -f "$staging/Hangar" ] || fail "Staged build has no Hangar: $staging"
[ -f "$target/Hangar" ] || fail "Target is not a Hangar install: $target"

# --- 1) Wait the daemon out, then insist -----------------------------------------------------------
waited=0
while kill -0 "$pid" 2> /dev/null; do
  if [ "$waited" -ge "$wait_seconds" ]; then
    say "Still running after ${wait_seconds}s -- stopping it"
    # Through the manager where there is one. launchd would take a killed daemon for a crash and
    # restart it (KeepAlive.SuccessfulExit=false) in the middle of the copy, so the job is unloaded
    # instead; start_app loads it again.
    case "$mode" in
      systemd) systemctl --user stop "$service" ;;
      launchd) launchctl bootout "gui/$(id -u)/$service" ;;
    esac
    kill -TERM "$pid" 2> /dev/null
    sleep 3
    kill -KILL "$pid" 2> /dev/null
    sleep 1
    break
  fi
  sleep 1
  waited=$((waited + 1))
done
say "Process $pid is gone"

# --- 2) Copy the payload over the install, preserving settings ------------------------------------
# Top-level entries are replaced one by one (unrelated files the install may have are left alone);
# wwwroot is replaced whole, so stale hashed assets are pruned.
say "Copying program files (preserving appsettings*.json)"
for path in "$staging"/* "$staging"/.[!.]*; do
  [ -e "$path" ] || continue
  name=$(basename "$path")
  case "$name" in
    appsettings.json | appsettings.*.json) continue ;;
  esac
  replace "$name" || fail "could not copy $name"
done
chmod +x "$target/Hangar" "$target/Hangar.PtyHost" 2> /dev/null
# A running tray keeps the old Hangar.Tray it has open; it sees the new one once it reconnects, and
# restarts into it.
[ -f "$target/Hangar.Tray" ] && chmod +x "$target/Hangar.Tray" 2> /dev/null
# On macOS, Hangar.Tray starts the app bundle beside it (see build.sh), which is replaced as a whole.
[ -d "$target/Hangar Tray App.app" ] && chmod +x "$target/Hangar Tray App.app/Contents/MacOS/"* 2> /dev/null

# --- 3) Back up on its feet ------------------------------------------------------------------------
start_app || fail "could not start the app"
say "=== apply-update: done ==="

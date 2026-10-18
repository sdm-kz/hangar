#!/usr/bin/env bash
# Installs a Linux or macOS build (scripts/build.sh) and starts it at sign-in, as the current user:
# a systemd user unit on Linux, a launchd agent on macOS. The counterpart of register-autostart.ps1.
#
# Usage:
#   scripts/install-unix.sh [publish dir] [install dir]   # defaults: ./publish, ~/.local/opt/hangar
#   scripts/install-unix.sh --uninstall                   # stop and remove the unit (files are kept)
#
# Why a user unit and not a system one: the server never logs in to anything -- it inherits a login.
# claude's credentials (the login keychain, on macOS), its settings and every store this app keeps live
# in your profile, so the daemon has to run as you. On Linux it runs while you are signed in; to keep it
# running across reboots with nobody signed in, run `loginctl enable-linger "$USER"` once.
#
# Two settings in the units below are load-bearing, and must survive any edit:
#   * KillMode=process (systemd) / AbandonProcessGroup (launchd). Each session lives in its own
#     Hangar.PtyHost, which outlives the daemon on purpose -- that is how a session survives a
#     restart or an update. Left at their defaults, both managers kill everything the daemon started
#     when it stops.
#   * Restart=on-failure / KeepAlive.SuccessfulExit=false, not "always": the in-app updater stops the
#     daemon cleanly and starts it itself once the files are replaced; a manager that restarted it
#     straight away would race the copy.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
systemd_unit=hangar.service
launchd_label=com.hangar.server

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=macos ;;
  *) echo "Linux or macOS only; on Windows use register-autostart.ps1." >&2; exit 2 ;;
esac

unit_path() {
  if [ "$platform" = linux ]; then
    echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$systemd_unit"
  else
    echo "$HOME/Library/LaunchAgents/$launchd_label.plist"
  fi
}

stop_unit() {
  if [ "$platform" = linux ]; then
    systemctl --user disable --now "$systemd_unit" 2> /dev/null || true
  else
    launchctl bootout "gui/$(id -u)/$launchd_label" 2> /dev/null || true
  fi
}

# The unit under its name from before the rename (claudeweb.service / com.claudeweb.server). One left
# behind would start the old build at sign-in beside this one, and the two would fight over the port.
# Its install folder is left alone: it is what a rollback would go back to.
remove_legacy_unit() {
  if [ "$platform" = linux ]; then
    legacy="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/claudeweb.service"
    [ -f "$legacy" ] || return 0
    systemctl --user disable --now claudeweb.service 2> /dev/null || true
    rm -f "$legacy"
    systemctl --user daemon-reload
  else
    legacy="$HOME/Library/LaunchAgents/com.claudeweb.server.plist"
    [ -f "$legacy" ] || return 0
    launchctl bootout "gui/$(id -u)/com.claudeweb.server" 2> /dev/null || true
    rm -f "$legacy"
  fi
  echo "Removed $legacy, the unit from before the rename. Running sessions keep running."
}

if [ "${1:-}" = "--uninstall" ]; then
  remove_legacy_unit
  stop_unit
  rm -f "$(unit_path)"
  [ "$platform" = linux ] && systemctl --user daemon-reload
  echo "Removed $(unit_path). Running sessions keep running; the install folder and the app's data are kept."
  exit 0
fi

publish=$(cd "${1:-$root/publish}" && pwd)
target=${2:-$HOME/.local/opt/hangar}
# A newline would end a line of the unit early and start a directive of its own.
nl='
'
case "$target" in *"$nl"*) echo "The install path may not contain a newline." >&2; exit 2 ;; esac
mkdir -p "$target"
target=$(cd "$target" && pwd) # the unit needs it absolute
# -f, not -x: a build made on Windows and copied over arrives without the executable bit, which the
# copy below sets anyway.
[ -f "$publish/Hangar" ] || { echo "No Hangar build in $publish -- run scripts/build.sh first." >&2; exit 1; }
[ -f "$publish/Hangar.PtyHost" ] || { echo "No Hangar.PtyHost in $publish." >&2; exit 1; }

# --- Files ---------------------------------------------------------------------------------------
# Stop first: a running daemon would be replaced underneath itself. Its sessions are not touched.
stop_unit
echo "==> Installing $publish -> $target"
for path in "$publish"/* "$publish"/.[!.]*; do
  [ -e "$path" ] || continue
  name=$(basename "$path")
  # Settings already in the install are yours; only a first install takes the published ones.
  case "$name" in
    appsettings.json | appsettings.*.json) [ -e "$target/$name" ] && continue ;;
  esac
  rm -rf "$target/.$name.new"
  cp -Rp "$path" "$target/.$name.new"
  rm -rf "$target/$name"
  mv "$target/.$name.new" "$target/$name"
done
chmod +x "$target/Hangar" "$target/Hangar.PtyHost"

if [ "$platform" = macos ]; then
  # A build made on another OS (or downloaded) arrives quarantined and, on Apple silicon, unsigned --
  # and macOS kills an unsigned arm64 binary on launch. An ad-hoc signature is all it needs.
  for exe in Hangar Hangar.PtyHost; do
    xattr -d com.apple.quarantine "$target/$exe" 2> /dev/null || true
    codesign --verify "$target/$exe" 2> /dev/null || codesign --force --sign - "$target/$exe"
  done
fi

# The PATH the daemon -- and so every session and shell it starts -- will see. A unit starts with
# little more than /usr/bin:/bin, which has neither claude nor most of what a session runs, so take the
# one this shell has. Absolute folders only: an empty entry or "." in a PATH means "the current folder",
# and for a session that is whatever repository it was started in -- a ./git there would then be run.
daemon_path=
old_ifs=$IFS
set -f # no globbing of the entries
IFS=:
for dir in $PATH "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
  case "$dir" in /*) ;; *) continue ;; esac
  case "$dir" in *"$nl"*) continue ;; esac
  [ -d "$dir" ] || continue
  case ":$daemon_path:" in *":$dir:"*) continue ;; esac
  daemon_path=${daemon_path:+$daemon_path:}$dir
done
IFS=$old_ifs
set +f
command -v claude > /dev/null 2>&1 || PATH=$daemon_path command -v claude > /dev/null 2>&1 \
  || echo "warning: claude is not on PATH; set Sessions:ClaudeExecutable in $target/appsettings.json." >&2

# --- Unit ----------------------------------------------------------------------------------------
# Stopped before the new unit starts, so the port is free for it.
remove_legacy_unit
unit=$(unit_path)
mkdir -p "$(dirname "$unit")"
if [ "$platform" = linux ]; then
  # % is a specifier everywhere in a unit; a "..." value takes \ escapes; ExecStart also expands $.
  esc() { printf '%s' "$1" | sed -e 's/%/%%/g'; }
  esc_q() { esc "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  esc_cmd() { esc_q "$1" | sed -e 's/\$/$$/g'; }
  cat > "$unit" << EOF
[Unit]
Description=Hangar server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(esc "$target")
ExecStart="$(esc_cmd "$target/Hangar")"
Environment="PATH=$(esc_q "$daemon_path")"
Environment=HANGAR_SERVICE_MANAGER=systemd
Environment=HANGAR_SERVICE_NAME=$systemd_unit
# Sessions run in pty hosts that must outlive this process; see the header of install-unix.sh.
KillMode=process
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$systemd_unit"
  echo "==> Started $systemd_unit (systemctl --user status $systemd_unit)"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2> /dev/null || echo no)" != yes ]; then
    echo "    It runs while you are signed in. To keep it running with nobody signed in:"
    echo "      loginctl enable-linger $USER"
  fi
else
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  cat > "$unit" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$launchd_label</string>
  <key>ProgramArguments</key><array><string>$(xml "$target/Hangar")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$target")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$daemon_path")</string>
    <key>HANGAR_SERVICE_MANAGER</key><string>launchd</string>
    <key>HANGAR_SERVICE_NAME</key><string>$launchd_label</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <!-- Sessions run in pty hosts that must outlive this process; see the header of install-unix.sh. -->
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
EOF
  # bootout (in stop_unit) returns before the old job is fully gone, and a bootstrap that lands in
  # that window fails; give it a few tries.
  loaded=
  for _ in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$unit"; then loaded=1; break; fi
    sleep 1
  done
  [ -n "$loaded" ] || { echo "launchctl bootstrap failed; load it with: launchctl bootstrap gui/$(id -u) $unit" >&2; exit 1; }
  echo "==> Started $launchd_label (launchctl print gui/$(id -u)/$launchd_label)"
fi

port=$(sed -n 's/.*"Urls"[^,}]*:\([0-9][0-9]*\)".*/\1/p' "$target/appsettings.json" | head -n 1)
echo "    Browse to http://localhost:${port:-5099}. Settings: $target/appsettings.json"

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
# The tray app on macOS (build.sh); elsewhere it is the Hangar.Tray executable alone.
tray_app="Hangar Tray App.app"
tray_bundle_id=io.github.sdm-kz.hangar.tray # tray/src-tauri/tauri.conf.json's identifier
# Linux: the tray's entry in the desktop's app menu, and the sign-in entry its own "Start when I sign
# in" writes (tauri-plugin-autostart: in ~/.config/autostart whatever XDG_CONFIG_HOME says, named after
# the executable). The app-menu entry is named by the app id the
# tray gives the desktop's shortcuts portal (tray/src-tauri/src/portal_hotkeys.rs), which is where the
# desktop finds the name and icon to show when it asks about the tray's hotkeys.
desktop_entry="${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.sdm_kz.hangar.tray.desktop"
autostart_entry="$HOME/.config/autostart/Hangar.Tray.desktop"

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

if [ "${1:-}" = "--uninstall" ]; then
  stop_unit
  rm -f "$(unit_path)"
  if [ "$platform" = linux ]; then
    systemctl --user daemon-reload
    rm -f "$desktop_entry" "$autostart_entry"
  fi
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
# A first install starts the tray at the end; an update restarts one that is running.
first_install=1
[ -e "$target/Hangar" ] && first_install=
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
# The tray app, when the build has one (build.sh makes it only on the machine it is for).
[ -f "$target/Hangar.Tray" ] && chmod +x "$target/Hangar.Tray"

if [ "$platform" = macos ]; then
  # A build made on another OS (or downloaded) arrives quarantined and, on Apple silicon, unsigned --
  # and macOS kills an unsigned arm64 binary on launch. An ad-hoc signature is all it needs.
  for exe in Hangar Hangar.PtyHost; do
    [ -f "$target/$exe" ] || continue
    xattr -d com.apple.quarantine "$target/$exe" 2> /dev/null || true
    codesign --verify "$target/$exe" 2> /dev/null || codesign --force --sign - "$target/$exe"
  done
  # The tray: an app bundle, with Hangar.Tray beside it a script that starts it (see build.sh).
  if [ -d "$target/$tray_app" ]; then
    xattr -dr com.apple.quarantine "$target/$tray_app" 2> /dev/null || true
    chmod +x "$target/$tray_app/Contents/MacOS/"*
    codesign --verify --deep "$target/$tray_app" 2> /dev/null || codesign --force --deep --sign - "$target/$tray_app"
  fi
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
  || echo "warning: claude is not on PATH; set Sessions:ClaudeExecutable in $target/appsettings.Local.json." >&2

# --- Unit ----------------------------------------------------------------------------------------
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
  # The daemon is a bare executable, which Login Items lists by its file name with the blank "exec"
  # icon. With the tray app installed, the job is filed under that app instead: its name and icon.
  associated=
  if [ -d "$target/$tray_app" ]; then
    associated="<key>AssociatedBundleIdentifiers</key><array><string>$tray_bundle_id</string></array>"
  fi
  cat > "$unit" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$launchd_label</string>
  $associated
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

# --- Tray ----------------------------------------------------------------------------------------
# Linux: an entry in the desktop's app menu, which a bare executable doesn't get (macOS lists the bundle
# itself). In a Desktop Entry's Exec a quoted argument escapes \ " ` and $ with a \, and then every \ of
# the value is doubled again, as in any string of the file; % stands for %%.
if [ "$platform" = linux ] && [ -f "$target/Hangar.Tray" ]; then
  desktop_q() { printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g'; }
  mkdir -p "$(dirname "$desktop_entry")"
  cat > "$desktop_entry" << ENTRY
[Desktop Entry]
Type=Application
Name=Hangar Tray
Comment=Hangar's running sessions, its server, and screenshots sent to a session
Exec="$(desktop_q "$target/Hangar.Tray")"
Icon=$target/Hangar.Tray.png
Terminal=false
Categories=Development;Utility;
ENTRY
fi

# Started on a first install, and restarted when it is running, so that an update doesn't leave the old
# build in the menu bar until the next sign-in. Only where there is a desktop session to show it in.
tray_cmd=
# Matched by the path its process runs from, which is the resolved one: a home reached through a link
# (/home -> /var/home, say) would otherwise never match.
target_real=$(cd "$target" && pwd -P)
if [ -d "$target/$tray_app" ]; then
  tray_cmd="$target_real/$tray_app/Contents/MacOS/"
elif [ -f "$target/Hangar.Tray" ]; then
  tray_cmd="$target_real/Hangar.Tray"
fi
re_escape() { printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|]/\\&/g'; }
tray_running() { pgrep -f "^$(re_escape "$tray_cmd")" > /dev/null 2>&1; }
# $1: --autostart on a restart, so it comes back without opening its settings.
start_tray() {
  if [ "$platform" = macos ]; then
    open -g "$target/$tray_app" ${1:+--args "$1"} 2> /dev/null
  elif command -v systemd-run > /dev/null 2>&1 \
    && systemctl --user show-environment 2> /dev/null | grep -E '^(WAYLAND_)?DISPLAY=' > /dev/null; then
    # A unit of the user's manager rather than a child of this shell, which may be an ssh session about
    # to end; the manager has the desktop session's environment.
    systemd-run --user --collect --quiet "$target/Hangar.Tray" ${1:+"$1"}
  elif [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    (setsid "$target/Hangar.Tray" ${1:+"$1"} > /dev/null 2>&1 &)
  else
    return 1
  fi
}
if [ -n "$tray_cmd" ]; then
  if tray_running; then
    pkill -f "^$(re_escape "$tray_cmd")" 2> /dev/null || true
    # Gone before the new one starts: a second instance would hand itself to the first and exit.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      tray_running || break
      sleep 0.5
    done
    if start_tray --autostart; then
      echo "==> Restarted the tray on the new build"
    else
      echo "    The tray was stopped for the update; start it again from $tray_cmd"
    fi
  elif [ -n "$first_install" ] && start_tray; then
    echo "==> Started the tray"
  fi
fi

# The port as the app reads it: appsettings.Local.json (this machine's own settings) over appsettings.json.
port=
for settings in "$target/appsettings.Local.json" "$target/appsettings.json"; do
  [ -f "$settings" ] || continue
  port=$(sed -n 's/.*"Urls"[^,}]*:\([0-9][0-9]*\)".*/\1/p' "$settings" | head -n 1)
  if [ -n "$port" ]; then break; fi
done
echo "    Browse to http://127.0.0.1:${port:-5099}."
echo "    Your settings: $target/appsettings.Local.json -- it overrides appsettings.json, and no update touches it."
if [ -d "$target/$tray_app" ]; then
  echo "    Tray app: $target/$tray_app -- its menu's \"Start when I sign in\" keeps it in the menu bar."
elif [ -f "$target/Hangar.Tray" ]; then
  echo "    Tray app: \"Hangar Tray\" in your app menu ($target/Hangar.Tray) -- its menu's \"Start when I sign in\""
  echo "    keeps it in the panel."
fi

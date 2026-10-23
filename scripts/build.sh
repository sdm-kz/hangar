#!/usr/bin/env bash
# Builds the SPA and publishes Hangar for Linux or macOS into ./publish: the daemon (Hangar) and
# the pty host (Hangar.PtyHost), each a single self-contained executable, and the tray app
# (Hangar.Tray) when it can be built here. The counterpart of build.ps1.
#
# The tray is a Tauri app, which builds only for the machine it is built on: it needs Rust, Node and
# the platform's webview headers (see tray/README.md). So it comes along when the build is for this
# machine's own platform and cargo is there, and is left out otherwise -- a cross-build from Windows
# for the NAS, say, which has no desktop to put a tray on anyway. --no-tray leaves it out regardless.
#
# Usage:  scripts/build.sh [--no-tray] [rid]
#   rid: linux-x64 | linux-arm64 | osx-arm64 | osx-x64 -- defaults to this machine's.
#
# It cross-builds from anywhere the .NET SDK and Node run, Git Bash on Windows included. A macOS build
# made on another OS comes out unsigned, which Apple silicon refuses to run; scripts/install-unix.sh
# signs it ad hoc when it installs it on the Mac.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

with_tray=1
if [ "${1:-}" = "--no-tray" ]; then
  with_tray=
  shift
fi

# This machine's own runtime id, when it is Linux or macOS.
host_rid=
case "$(uname -s)" in
  Linux) host_os=linux ;;
  Darwin) host_os=osx ;;
  *) host_os= ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) host_arch=x64 ;;
  arm64 | aarch64) host_arch=arm64 ;;
  *) host_arch= ;;
esac
[ -n "$host_os" ] && [ -n "$host_arch" ] && host_rid="$host_os-$host_arch"

rid=${1:-}
if [ -z "$rid" ]; then
  [ -n "$host_os" ] || { echo "Pass a runtime id (linux-x64, linux-arm64, osx-arm64, osx-x64) on this OS." >&2; exit 2; }
  [ -n "$host_arch" ] || { echo "Unsupported CPU: $(uname -m)" >&2; exit 2; }
  rid=$host_rid
fi
case "$rid" in
  linux-x64 | linux-arm64 | osx-x64 | osx-arm64) ;;
  *) echo "Unsupported runtime id: $rid" >&2; exit 2 ;;
esac

publish="$root/publish"

echo "==> Building frontend (web)"
(
  cd "$root/web"
  [ -d node_modules ] || npm install
  npm run build # emits into ../server/wwwroot
)

echo "==> Publishing daemon (server) for $rid"
rm -rf "$publish"
dotnet publish "$root/server" -c Release -r "$rid" --self-contained true \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -o "$publish"

# Published into a scratch folder and copied in, so its runtime files can't land on top of the daemon's.
# Trimmed for the same reason as on Windows (see build.ps1): one of these runs per session.
echo "==> Publishing pty host (ptyhost) for $rid"
pty_out="$root/publish-ptyhost"
rm -rf "$pty_out"
dotnet publish "$root/ptyhost" -c Release -r "$rid" --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -o "$pty_out"
cp -R "$pty_out"/. "$publish"/
rm -rf "$pty_out"

# The tray app, for this machine only (see the header).
tray_note="left out (--no-tray)"
if [ -n "$with_tray" ]; then
  if [ "$rid" != "$host_rid" ]; then
    tray_note="left out: a $rid tray can only be built on a $rid machine"
  elif ! command -v cargo > /dev/null 2>&1; then
    tray_note="left out: no cargo (Rust) here"
  else
    echo "==> Building tray (tray) for $rid"
    # A tray that fails to build (the webview headers missing, say) is left out rather than taking the
    # server's build down with it. Chained with &&: set -e doesn't reach inside an if's condition.
    # --no-bundle: the executable is all an install needs; .deb/.dmg are for handing it to others.
    if (cd "$root/tray" && { [ -d node_modules ] || npm ci; } && npx tauri build --no-bundle); then
      cp "$root/tray/src-tauri/target/release/hangar-tray" "$publish/Hangar.Tray"
      chmod +x "$publish/Hangar.Tray"
      tray_note="$publish/Hangar.Tray"
    else
      echo "warning: the tray did not build; the rest of the build goes on without it." >&2
      tray_note="left out: its build failed (see above)"
    fi
  fi
fi

# The pipeline that produced these may not have carried the executable bit (a build on Windows).
chmod +x "$publish/Hangar" "$publish/Hangar.PtyHost"
# Windows-only leftovers of the web SDK.
rm -f "$publish/web.config"

# --- Build stamp (see build.ps1) ------------------------------------------------------------------
commit=$(git -C "$root" rev-parse --short HEAD 2> /dev/null || true)
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2> /dev/null || true)
built_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
build_id="$(date -u '+%Y%m%dT%H%M%SZ')-${commit:-nogit}"
json_or_null() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }
cat > "$publish/build.json" << EOF
{
  "buildId": "$build_id",
  "commit": $(json_or_null "$commit"),
  "branch": $(json_or_null "$branch"),
  "builtAtUtc": "$built_at",
  "runtime": "$rid"
}
EOF

for exe in Hangar Hangar.PtyHost; do
  [ -f "$publish/$exe" ] || { echo "$exe is missing from $publish" >&2; exit 1; }
done
echo "==> Done. Published to: $publish ($rid)"
echo "    Build stamp: $build_id"
echo "    Run the server:   $publish/Hangar   (headless; browse to its port)"
echo "    Tray app:         $tray_note"
echo "    Install it:       scripts/install-unix.sh $publish   (systemd user unit or launchd agent)"

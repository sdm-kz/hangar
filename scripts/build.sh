#!/usr/bin/env bash
# Builds the SPA and publishes Claude Web for Linux or macOS into ./publish: the daemon (ClaudeWeb) and
# the pty host (ClaudeWeb.PtyHost), each a single self-contained executable. The counterpart of
# build.ps1, minus the tray, which is Windows-only (WinForms).
#
# Usage:  scripts/build.sh [rid]
#   rid: linux-x64 | linux-arm64 | osx-arm64 | osx-x64 -- defaults to this machine's.
#
# It cross-builds from anywhere the .NET SDK and Node run, Git Bash on Windows included. A macOS build
# made on another OS comes out unsigned, which Apple silicon refuses to run; scripts/install-unix.sh
# signs it ad hoc when it installs it on the Mac.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

rid=${1:-}
if [ -z "$rid" ]; then
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=osx ;;
    *) echo "Pass a runtime id (linux-x64, linux-arm64, osx-arm64, osx-x64) on this OS." >&2; exit 2 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 2 ;;
  esac
  rid="$os-$arch"
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

# The pipeline that produced these may not have carried the executable bit (a build on Windows).
chmod +x "$publish/ClaudeWeb" "$publish/ClaudeWeb.PtyHost"
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

for exe in ClaudeWeb ClaudeWeb.PtyHost; do
  [ -f "$publish/$exe" ] || { echo "$exe is missing from $publish" >&2; exit 1; }
done
echo "==> Done. Published to: $publish ($rid)"
echo "    Build stamp: $build_id"
echo "    Run the server:   $publish/ClaudeWeb   (headless; browse to its port)"
echo "    Install it:       scripts/install-unix.sh $publish   (systemd user unit or launchd agent)"

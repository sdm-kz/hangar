#!/bin/sh
# Installs Hangar from a GitHub release, on Linux or macOS:
#
#   curl -fsSL https://github.com/sdm-kz/hangar/releases/latest/download/install.sh | sh
#
# It downloads this machine's build from the release, checks it against the release's SHA256SUMS, and
# installs it with the build's own scripts/install-unix.sh -- the same install a checkout makes: into
# ~/.local/opt/hangar, started now and at sign-in (a systemd user unit, or a launchd agent). Run it
# again to update: settings, the app's data and running sessions are kept.
#
# Settings, as environment variables, set for the sh at the end of the pipe (... | HANGAR_VERSION=1.2.0 sh):
#   HANGAR_VERSION      the release to install (1.2.0, or a prerelease such as 1.2.0-rc.1); the latest by default
#   HANGAR_INSTALL_DIR  where to install it; ~/.local/opt/hangar by default
#
# Plain sh, not bash: it is what the pipe runs. Everything is in main(), called on the last line, so a
# download cut short partway runs nothing.
set -eu

repo=sdm-kz/hangar

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=osx ;;
    *) fail "Linux and macOS only. On Windows, in PowerShell: irm https://github.com/$repo/releases/latest/download/install.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "No build for this CPU ($(uname -m))." ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon; the Mac itself takes the arm64 build.
  if [ "$os" = osx ] && [ "$(sysctl -n hw.optional.arm64 2> /dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  rid=$os-$arch
  case "$rid" in
    linux-x64 | linux-arm64 | osx-arm64) ;;
    *) fail "There is no release build for $rid; build it from source: https://github.com/$repo#quick-start" ;;
  esac

  if [ -n "${HANGAR_VERSION:-}" ]; then
    base=https://github.com/$repo/releases/download/v${HANGAR_VERSION#v}
  else
    base=https://github.com/$repo/releases/latest/download
  fi

  # install-unix.sh is bash; tar and a SHA-256 tool for the download.
  command -v bash > /dev/null 2>&1 || fail "bash is needed to install Hangar."
  command -v tar > /dev/null 2>&1 || fail "tar is needed to install Hangar."
  if command -v curl > /dev/null 2>&1; then
    fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  elif command -v wget > /dev/null 2>&1; then
    fetch() { wget -q --https-only -O "$2" "$1"; }
  else
    fail "curl or wget is needed to download Hangar."
  fi
  if command -v sha256sum > /dev/null 2>&1; then
    sha256() { sha256sum "$1" | awk '{ print $1 }'; }
  elif command -v shasum > /dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | awk '{ print $1 }'; }
  else
    fail "sha256sum or shasum is needed to check the download."
  fi

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT TERM

  archive=hangar-$rid.tar.gz
  say "Downloading $base/$archive"
  fetch "$base/$archive" "$work/$archive" || fail "Could not download $base/$archive."
  fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || fail "Could not download $base/SHA256SUMS."

  # sha256sum's lines are "<hash>  <name>", or "<hash> *<name>" in binary mode.
  expected=$(awk -v f="$archive" '$2 == f || $2 == "*" f { print $1; exit }' "$work/SHA256SUMS")
  [ -n "$expected" ] || fail "$archive is not listed in the release's SHA256SUMS."
  actual=$(sha256 "$work/$archive")
  [ "$expected" = "$actual" ] || fail "$archive does not match the release's SHA256SUMS (expected $expected, got $actual)."

  # -o: owned by whoever runs this, not by the CI runner's uid recorded in the archive -- which root's
  # tar would otherwise restore, handing the install to whichever local user has that uid.
  tar -xzof "$work/$archive" -C "$work"
  dir=$work/hangar-$rid
  [ -f "$dir/scripts/install-unix.sh" ] || fail "$archive has no scripts/install-unix.sh."
  version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dir/publish/build.json" | head -n 1)
  say "Installing Hangar ${version:-(unversioned build)} for $rid"

  command -v claude > /dev/null 2>&1 \
    || warn "the Claude Code CLI (claude) is not on PATH. Hangar needs it: https://github.com/$repo/blob/main/docs/install.md#prerequisites"

  # Not reading this script's pipe: stdin is what is left of it.
  bash "$dir/scripts/install-unix.sh" "$dir/publish" ${HANGAR_INSTALL_DIR:+"$HANGAR_INSTALL_DIR"} < /dev/null

  # The script that set this up, kept with the install for --uninstall: the download is deleted on exit.
  target=${HANGAR_INSTALL_DIR:-$HOME/.local/opt/hangar}
  mkdir -p "$target/scripts"
  cp "$dir/scripts/install-unix.sh" "$target/scripts/install-unix.sh"

  say "Hangar is installed. Until you set a password it answers only this machine:"
  echo "    https://github.com/$repo/blob/main/docs/install.md#first-run-set-a-password"
  echo "    To remove it: $target/scripts/install-unix.sh --uninstall"
}

main "$@"

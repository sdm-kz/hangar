#!/usr/bin/env bash
# Gives this Mac a code-signing identity of its own for Hangar, so the permissions granted to the tray app
# -- Screen Recording, Accessibility -- survive its updates. Run once, on the Mac, as the user Hangar runs as.
#
# Usage:  scripts/setup-macos-signing.sh            # create it (does nothing when it is already there)
#         scripts/setup-macos-signing.sh --remove   # delete it; builds go back to being signed ad hoc
#
# Why: without an Apple Developer ID, a build is signed ad hoc, and macOS knows an ad-hoc app by the hash
# of its code. Every update is new code, so macOS takes it for a different app: the switch under Privacy &
# Security stays on, but it belongs to the last build, and captures come out blank until it is removed and
# granted again. Signed with a certificate instead, the app is known by its bundle id and that
# certificate, which stay the same from one build to the next.
#
# What it makes, in ~/Library/Application Support/Hangar/codesign (readable by this user only):
#   signing.keychain-db  a keychain of its own holding a self-signed certificate ("Hangar Self-Signed",
#                        good for ten years) and its private key. Not on the keychain search list, so
#                        nothing else picks it up; codesign is pointed at it.
#   keychain-password    that keychain's password, random, so staging an update over ssh can unlock it
#                        without anyone typing anything.
#   identity             the certificate's SHA-1, which codesign signs by.
# The certificate needs no trust settings: macOS checks a signature against the certificate it names,
# not against a chain of trust, when it decides whether an app is the one it granted a permission to.
#
# The trade-off: any program running as you on this Mac can read the password and sign itself as the
# tray app, and so inherit what you granted the tray. Such a program can already replace the tray's
# files in ~/.local/opt/hangar; with ad-hoc signing that costs it the permissions, with this it doesn't.
#
# stage-update-remote.sh and build.sh sign with this identity whenever it is there; install-unix.sh keeps
# a build's signature when it is valid. Granted once after the first build signed this way, the
# permissions then stay. Removing or re-creating the identity is a new app to macOS again.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "macOS only." >&2; exit 2; }
dir="$HOME/Library/Application Support/Hangar/codesign"
keychain="$dir/signing.keychain-db"
name="Hangar Self-Signed"

if [ "${1:-}" = "--remove" ]; then
  if [ -f "$keychain" ]; then security delete-keychain "$keychain"; fi
  rm -f "$dir/keychain-password" "$dir/identity"
  echo "Removed. Builds are signed ad hoc again."
  exit 0
fi

if [ -f "$keychain" ] && [ -s "$dir/identity" ]; then
  echo "Already set up: $(cat "$dir/identity") in $keychain"
  exit 0
fi

mkdir -p "$dir"
chmod 700 "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A leaf certificate for code signing only. /usr/bin/openssl (LibreSSL) writes a PKCS#12 that
# `security import` reads; a Homebrew OpenSSL 3 would need -legacy for that.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$name" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2> /dev/null
/usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" \
  -passout pass:transfer -out "$work/identity.p12"

password=$(/usr/bin/openssl rand -hex 24)
(umask 077 && printf '%s' "$password" > "$dir/keychain-password")
rm -f "$keychain"
security create-keychain -p "$password" "$keychain"
# No lock after a timeout or on sleep: it is unlocked by whoever signs, when they sign.
security set-keychain-settings "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P transfer -T /usr/bin/codesign > /dev/null
# Let codesign use the key without a dialog, which no one would be there to click over ssh.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
security lock-keychain "$keychain"

/usr/bin/openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' > "$dir/identity"
chmod 600 "$dir/identity" "$keychain"
echo "Created \"$name\" ($(cat "$dir/identity")) in $keychain"
echo "The next build staged or built here is signed with it. Grant the tray its permissions once more"
echo "after installing that build; from then on they stay."

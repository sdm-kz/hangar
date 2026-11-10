#!/usr/bin/env bash
# Makes the key the release workflow signs each release's SHA256SUMS with, once per repository.
#
# Usage:  scripts/setup-release-signing.sh <folder for the private key> [owner/repo]
#
# Why: an installed Hangar stages a newer release by itself (server/Update/GitHubReleaseSource.cs), and the
# SHA256SUMS it checks the download against comes from the same release, so it only proves the download
# whole. The signature proves where it came from: it is made with a private key that only the release
# workflow has (the RELEASE_SIGNING_KEY secret), and checked with the public half each build carries
# (server/Update/release-key.pem). A release without it, or signed with another key, is not staged.
#
# What it does:
#   1. makes an ECDSA P-256 key in <folder>/release-signing.key.pem, readable by you alone;
#   2. writes its public half to server/Update/release-key.pem;
#   3. stores the private key as the repository secret RELEASE_SIGNING_KEY (with gh).
# Then commit server/Update/release-key.pem: builds from then on carry it.
#
# Keep the private key somewhere safe and offline. Every install trusts the key it was built with, so a new
# key leaves the installs built with the old one unable to take a release by themselves: each one needs the
# one-line installer run again. The script refuses to replace a key that is already there.
set -euo pipefail

dir=${1:?usage: scripts/setup-release-signing.sh <folder for the private key> [owner/repo]}
repo=${2:-sdm-kz/hangar}
root=$(cd "$(dirname "$0")/.." && pwd)
key="$dir/release-signing.key.pem"
pub="$root/server/Update/release-key.pem"

command -v openssl > /dev/null || { echo "openssl is needed" >&2; exit 1; }
command -v gh > /dev/null || { echo "gh is needed (https://cli.github.com)" >&2; exit 1; }
[ -d "$dir" ] || { echo "$dir is not a folder" >&2; exit 1; }
if [ -e "$key" ] && [ -e "$pub" ] && openssl pkey -in "$key" -pubout 2> /dev/null | cmp -s - "$pub"; then
  # A run that made the key and then failed to store it (no network, GitHub's rate limit): finish it.
  echo "==> The key is already made; storing the secret"
elif [ -e "$key" ] || [ -e "$pub" ]; then
  echo "A release key is already there ($key or $pub). Not replacing it: installs trust the key they were" >&2
  echo "built with. Remove both by hand to make a new one, knowing what that does (see the top of this script)." >&2
  exit 1
else
  (umask 077 && openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key")
  openssl pkey -in "$key" -pubout -out "$pub"
fi
gh secret set RELEASE_SIGNING_KEY --repo "$repo" < "$key"

echo "==> Private key:  $key (keep it safe; it is not needed again unless the secret is lost)"
echo "==> Public key:   $pub -- commit it"
echo "==> Secret RELEASE_SIGNING_KEY set on $repo"

[← Hangar](../README.md)

# Releasing

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)),
not on a workstation: a tag builds every platform on its own runner, the tray included, from the tagged
commit alone.

## Cutting a release

```bash
git tag v0.2.0          # or v0.2.0-rc.1 for a prerelease
git push origin v0.2.0
```

The workflow then:

1. builds `win-x64`, `win-arm64`, `osx-arm64`, `osx-x64`, `linux-x64` and `linux-arm64` with `scripts/build.ps1` /
   `scripts/build.sh`, with `HANGAR_VERSION` set from the tag. The version lands in each build's
   `build.json` (and so in the Update dialog) and in the executables' version info;
2. packs each as `hangar-<rid>.zip` (Windows) or `hangar-<rid>.tar.gz`: a `hangar-<rid>/` folder with the
   build in `publish/` and the scripts that install it in `scripts/`;
3. adds `install.sh`, `install.ps1` and `SHA256SUMS`, records build provenance for every file (public
   repository only), and creates a **draft** release whose text lists the `feat`, `fix` and `perf`
   commits since the last release (a prerelease's previous release is the last that was not one).

A build that fails, a tray included, fails the release: there is no release with a platform missing.

Look the draft over, edit its notes, and **Publish** it. The text is also what an installed Hangar shows
as "what's new" before it updates itself (see [Updating](updating.md#from-a-release)), so write it for
the people reading it there: each `- ` line is one change, and a plain line above them is the summary on
the Update button's tooltip. Headings and the "Full Changelog" link are left out. A user skipping
releases sees the changes of every release since theirs.

Only a published release that is not a prerelease is `releases/latest`, which is where the one-line
installers download from, and what installed Hangars update to:

```bash
curl -fsSL https://github.com/sdm-kz/hangar/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/sdm-kz/hangar/releases/latest/download/install.ps1 | iex
```

A prerelease, or any older release, is installed by naming it:

```bash
curl -fsSL https://github.com/sdm-kz/hangar/releases/download/v0.2.0-rc.1/install.sh | HANGAR_VERSION=0.2.0-rc.1 sh
```

```powershell
$env:HANGAR_VERSION = "0.2.0-rc.1"; irm https://github.com/sdm-kz/hangar/releases/download/v0.2.0-rc.1/install.ps1 | iex
```

The asset names carry no version, so that `releases/latest/download/<name>` always resolves; the release
says which version it is, and so does each build's `build.json`.

## The macOS signing identity

Without an Apple Developer ID, the tray is signed with a self-signed certificate so that macOS keeps the
permissions granted to it (Screen Recording, Accessibility) from one release to the next (see
[`scripts/setup-macos-signing.sh`](../scripts/setup-macos-signing.sh) for why). For releases, that
certificate is one identity shared by every install, kept in two repository secrets. Without them the
tray is signed ad hoc, and every update asks for its permissions again.

Make it once, on a Mac, with the system's `/usr/bin/openssl` (LibreSSL writes a PKCS#12 that
`security import` reads; OpenSSL 3 would need `-legacy`):

```bash
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Hangar Release" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout key.pem -out cert.pem
password=$(/usr/bin/openssl rand -hex 24)
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "Hangar Release" \
  -passout "pass:$password" -out release.p12
base64 -i release.p12 | gh secret set MACOS_SIGNING_P12 --repo sdm-kz/hangar
printf '%s' "$password" | gh secret set MACOS_SIGNING_P12_PASSWORD --repo sdm-kz/hangar
rm key.pem
```

Keep `release.p12` and its password somewhere safe and offline: replacing the identity makes every
installed tray a new app to macOS, which then needs its permissions granted once more. So does the first
release install on a Mac whose tray was signed with that Mac's own identity.

## Checking a download

`SHA256SUMS` comes from the same release as the archives, so the installers' check catches a corrupted
or truncated download, not a release that was tampered with. For that, check the provenance, which
GitHub signs with the identity of the workflow run that built the file:

```bash
gh attestation verify hangar-linux-x64.tar.gz --repo sdm-kz/hangar
```

## While the repository is private

- A private repository's release files can't be downloaded without signing in, so the one-liners only
  work once it is public. Test a draft or prerelease with
  `gh release download v0.2.0-rc.1 --repo sdm-kz/hangar` instead.
- Provenance is skipped: GitHub keeps attestations for private repositories only on Enterprise Cloud.
- Actions minutes are metered, macOS at ten times the rate, and the arm64 runners may not be available.

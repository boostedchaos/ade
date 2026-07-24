# Releasing the macOS desktop app

Written 2026-07-24 while shipping `mac-v0.3.0`. Tag family is `mac-v*` — plain
`v*` is reserved for the headless ade-server pipeline and `desktop-v*` is the
upstream trap (see `releasing-windows.md` for the tag namespace map).

There is no mac CI leg; mac releases are built locally on an Apple Silicon Mac
and published by hand.

## Build

Two traps, both learned the hard way (2026-07-23):

1. **Do not build under a File-Provider-synced tree** (`~/Documents` etc.) —
   macOS re-stamps `com.apple.provenance`/FinderInfo xattrs faster than they
   can be stripped and ad-hoc codesign fails with "resource fork, Finder
   information, or similar detritus not allowed". Clone to `/private/tmp`.
2. **`SUPERSET_WORKSPACE_NAME` bakes into the bundle at build time**
   (`defineEnv` → literal; runtime env is ignored). Public artifacts must be
   built with it UNSET (app uses `~/.ade`). Never build from a shell inside an
   ADE agent session without scrubbing `SUPERSET_*` env vars.

```bash
git clone --branch main <repo> /private/tmp/ade-macbuild
cd /private/tmp/ade-macbuild && bun install
cd apps/desktop
env -u SUPERSET_WORKSPACE_NAME -u SUPERSET_ENV -u SUPERSET_PORT bun run prebuild
env -u SUPERSET_WORKSPACE_NAME bun run build
```

Artifacts land in `release/`: `ADE-<version>-arm64.dmg`, `ADE-<version>-arm64-mac.zip`.

## Smoke test

Launch the built binary directly and confirm it boots past DB migration:

```bash
./release/mac-arm64/ADE.app/Contents/MacOS/ADE   # watch for "[local-db] Migrations complete"
```

## Publish

```bash
shasum -a 256 ADE-*-arm64.dmg ADE-*-arm64-mac.zip > SHA256SUMS.txt
gh release create mac-vX.Y.Z --target "$(git rev-parse HEAD)" \
  --title "ADE macOS X.Y.Z" --notes-file notes.md \
  ADE-X.Y.Z-arm64.dmg ADE-X.Y.Z-arm64-mac.zip SHA256SUMS.txt
```

`--target` needs a **full** SHA and must be the commit the build was actually
made from. Then verify the published bytes: re-download the assets with
`gh release download` and `shasum -a 256 -c SHA256SUMS.txt`.

The build is ad-hoc signed, not notarized — release notes must tell users
about right-click → Open / Privacy & Security approval.

Note: `--latest` is left for the Windows release to keep GitHub's "Latest"
badge on the higher-traffic channel; pass `--latest=false` explicitly if
GitHub's default would steal it.

# Releasing the Windows port

How a `windows-v*` release is cut. Written 2026-07-15 while shipping 0.2.0.

## The trap: `release-desktop.yml` cannot ship Windows

Upstream's `release-desktop.yml` triggers on `desktop-v*.*.*` and looks like the
release path. It is not, for this fork:

- Its post-processing step only handles `.dmg`, `-mac.zip`, and `.AppImage`.
  There is no Windows branch — no `.exe`, no `-x64.zip`.
- It fans out to `build-desktop.yml`, which builds macOS + Linux + Windows. The
  macOS legs need signing secrets this fork does not have.
- It publishes a **draft** titled `ADE desktop-vX.Y.Z`.

Tagging `desktop-v0.3.0` therefore burns a three-platform build and produces a
draft with no Windows installer in it. **Do not use it.**

Windows tags are deliberately named `windows-v*`, which does **not** match
`desktop-v*.*.*`, so tagging a release fires no workflow at all.

## The actual path

`windows-ci.yml` already builds and smoke-tests the full Windows package on
every push to `main`, and uploads `ade-windows-x64` (the `.exe`, the portable
`.zip`, and `latest.yml`). A release is that artifact, published by hand.

1. Bump `apps/desktop/package.json` `version`. This is the only version that
   matters — `electron-builder.ts` derives the installer name from it
   (`${productName}-${pkg.version}-${arch}.${ext}`). The other `apps/*`
   package.json versions are upstream's and are irrelevant here.
2. Push to `main`. Wait for **Windows CI (ground truth)** to go green — it gates
   on typecheck, the full desktop suite against the Windows baseline, the
   `control-plane` and `cli` suites (no baseline — any failure fails CI), the
   package verify step, a packaged-resource guard (the `ade` CLI, the bundled
   `skills/`, and the agent hook templates are all present in the bundle), and
   three smokes (native modules under packaged Electron; the app boots and
   initializes `~/.ade`; and the bundled `ade` CLI reaches the control server
   over the named pipe).
3. Download the artifact and generate checksums:

   ```bash
   gh run download <run-id> -n ade-windows-x64 -D ./rel
   cd rel && shasum -a 256 ADE-*-x64.exe ADE-*-x64.zip > SHA256SUMS.txt
   ```

4. Publish against the **CI-verified commit** (full SHA — `--target` rejects a
   short SHA with `422 target_commitish is invalid`):

   ```bash
   gh release create windows-vX.Y.Z --target "$(git rev-parse HEAD)" \
     --title "ADE Windows X.Y.Z" --notes-file notes.md --latest \
     ADE-X.Y.Z-x64.exe ADE-X.Y.Z-x64.zip SHA256SUMS.txt
   ```

5. Verify the published bytes, not the upload: re-download the asset and check
   it against the published `SHA256SUMS.txt`. That is the exact path `WINDOWS.md`
   tells users to follow with `Get-FileHash`, so it should be proven to work.

Ship `.exe`, `.zip`, and `SHA256SUMS.txt`. `latest.yml` is not published —
auto-update is intentionally disabled (see `src/main/lib/auto-updater.ts`).

## Notes

- Builds are unsigned; SmartScreen will warn. Release notes must say so, and must
  keep the "not an official upstream release" framing.
- `RELEASE_REPO_OWNER`/`RELEASE_REPO_NAME` are duplicated in `electron-builder.ts`
  and `src/main/lib/auto-updater.ts`. They must stay in sync, and must point at
  this fork — never upstream, or users would update off someone else's feed.

## Build-time workspace bake (applies to ALL platforms)

`electron.vite.config.ts` bakes `SUPERSET_WORKSPACE_NAME` into the bundle at
BUILD time (`defineEnv` → literal; runtime env is ignored). The baked value
selects the data dir `~/.ade-<name>` (unset → plain `~/.ade`).

- Public release artifacts: build with the variable UNSET.
- Kyle's personal install uses `~/.ade-default`, so his replacement builds
  must be produced with `SUPERSET_WORKSPACE_NAME=default`.
- NEVER build from a shell inside an ADE agent session without scrubbing the
  env: agent terminals carry `SUPERSET_WORKSPACE_NAME=<workspace>` and the
  value silently bakes in (caught 2026-07-23 when a build bound itself to
  `.ade-ethel`).

Also: macOS packaging fails with codesign "resource fork/detritus" errors when
building under a File-Provider-synced tree (~/Documents). Clone to a
non-synced path (e.g. /private/tmp) to package.

## Tag namespace map (post-papyrus, 2026-07-24)

- `windows-v*` — desktop Windows releases, cut by hand per this doc.
- `v*` — RESERVED: fires papyrus's `release.yml`, which builds and publishes
  the headless `ade-server` bundle. Do not use plain `v*` for desktop.
- `desktop-v*` — still the upstream trap described above; never use.
- Future mac desktop releases should use a `mac-v*` family for the same
  reason (`v*` is taken by the server pipeline).

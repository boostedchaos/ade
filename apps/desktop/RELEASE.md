# Desktop App Release Process

## Quick Start

From the monorepo root:

```bash
./apps/desktop/create-release.sh
```

On Windows, run the script from Git Bash (it needs bash, `gh`, and `jq`).

The script will:

1. Show current version and prompt for new version (patch/minor/major/custom)
2. Update `package.json` version
3. Create and push a `desktop-v<version>` tag
4. Monitor the GitHub Actions build
5. Create a **draft release** for review

### Options

```bash
# Interactive version selection (recommended)
./apps/desktop/create-release.sh

# Explicit version
./apps/desktop/create-release.sh 0.0.50

# Auto-publish (skip draft)
./apps/desktop/create-release.sh --publish
./apps/desktop/create-release.sh 0.0.50 --publish
```

To publish a draft:

```bash
gh release edit desktop-v0.0.50 --draft=false
```

### Requirements

- GitHub CLI (`gh`) installed and authenticated
- Clean git working directory

## Manual Release

If you prefer not to use the script:

```bash
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

This creates a draft release. Publish it manually at GitHub Releases.

## Auto-update

Auto-update is DISABLED (see `src/main/lib/auto-updater.ts`,
`AUTO_UPDATE_ENABLED = false`; Windows is additionally excluded by
`IS_AUTO_UPDATE_PLATFORM` until builds are code-signed — decision 2026-07-13:
Windows builds ship unsigned, so the updater stays off there). Once enabled, the
app checks for updates at launch and every few hours using this repo's Releases:

- **macOS manifest**: `https://github.com/boostedchaos/ade-windows-port/releases/latest/download/latest-mac.yml`
- **Linux manifest**: `https://github.com/boostedchaos/ade-windows-port/releases/latest/download/latest-linux.yml`
- **Windows manifest**: `https://github.com/boostedchaos/ade-windows-port/releases/latest/download/latest.yml`
- **macOS installer**: `https://github.com/boostedchaos/ade-windows-port/releases/latest/download/ADE-arm64.dmg`
- **Linux installer**: `https://github.com/boostedchaos/ade-windows-port/releases/latest/download/ADE-x64.AppImage`

The workflow creates stable-named copies (without version) so these URLs always point to the latest build.

To turn auto-update on: flip `AUTO_UPDATE_ENABLED` to `true` in
`src/main/lib/auto-updater.ts` (and, for Windows, sign the builds and add
`PLATFORM.IS_WINDOWS` to `IS_AUTO_UPDATE_PLATFORM`), then ship a build.

## Code Signing

macOS code signing uses these repository secrets:

- `MAC_CERTIFICATE` / `MAC_CERTIFICATE_PASSWORD`
- `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID`

Windows builds are intentionally unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
Signing was evaluated 2026-07-13 (Azure Artifact Signing $9.99/mo, SignPath OSS)
and skipped — the port is personal-use; revisit before any wider distribution,
and land signing before (or with) enabling Windows auto-update.

## Local Testing

```bash
cd apps/desktop
bun run clean:dev
bun run compile:app
bun run package
```

Output: `apps/desktop/release/`

Linux output should include:

- `*.AppImage`
- `*-linux.yml` (auto-update manifest)

## Troubleshooting

- **Linux auto-update not working**: Verify `release/*-linux.yml` is uploaded to the GitHub release
- **Build icon warnings/failures**: Add icons under `src/resources/build/icons/` (`icon.icns`, `icon.ico`, optional Linux `.png`)
- **Native module errors**: Ensure `node-pty` is in externals in both `electron.vite.config.ts` and `electron-builder.ts`

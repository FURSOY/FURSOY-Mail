# Build and release map

- Frontend build: `npm run build`
- Windows bundle: `npm run dist:windows`
- Full local release bundle and updater manifest: `npm run release:windows`
- CI release workflow: `.github/workflows/release.yml`, triggered by a `v*` tag. Default notes come from `.github/release-notes.md`; update that file for each release.

Before a release, confirm the requested version and release notes, then keep `package.json` and `src-tauri/tauri.conf.json` versions identical. Run the relevant build checks and inspect the installer plus `latest.json` outputs before publishing.

Never create a tag, push, or publish merely because code is ready. Confirm both the exact release target and the publisher identity. The current workflow publishes with `github.token`, so GitHub may attribute the release to `github-actions[bot]`; do not use it if the user requires the release to be shown as personally published.

# Build and release map

- Frontend build: `npm run build`
- Windows bundle: `npm run dist:windows`
- Full local release bundle and updater manifest: `npm run release:windows`
- CI release workflow: `.github/workflows/release.yml`, triggered by a `v*` tag. Default notes come from `.github/release-notes.md`; update that file for each release.

Before a release, confirm the requested version and release notes, then keep `package.json` and `src-tauri/tauri.conf.json` versions identical. Run the relevant local build and test checks before publishing. When a local bundle is explicitly requested, inspect the installer and `latest.json` outputs as well.

For normal tagged releases, do not build or test the Windows NSIS installer locally unless the user explicitly asks. Run the frontend/Rust checks locally, then let the tagged GitHub Actions workflow build, sign, and validate the NSIS installer and `latest.json` artifacts.

After a release tag is successfully pushed, do not monitor GitHub Actions or wait for the GitHub release to finish unless the user explicitly asks. Hand control back immediately; investigate the workflow only when the user reports a release problem.

Never create a tag, push, or publish merely because code is ready. Confirm both the exact release target and the publisher identity. The current workflow publishes with `github.token`, so GitHub may attribute the release to `github-actions[bot]`; do not use it if the user requires the release to be shown as personally published.

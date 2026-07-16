# FURSOY Mail — Codex guide

Desktop Gmail client: Tauri 2, React/TypeScript/Vite frontend, Rust backend. The app currently supports Google accounts only.

## Work with the smallest useful context

1. Start with `git status --short`; preserve unrelated user changes.
2. Search before reading: use `rg` to locate the handler, command, or symbol. Read the matching function and its direct callers only.
3. Do not read all of `src/App.tsx`, `src/utils.ts`, `src-tauri/src/gmail.rs`, or `src-tauri/src/db.rs` for a focused change.

| If changing… | Start here | Then read |
| --- | --- | --- |
| UI, selection, sync, keyboard flow | `src/App.tsx` | `.agents/context/frontend.md` |
| A visible panel | `src/components/<name>.tsx` | its props/callers |
| Email rendering, OTP, links, zoom | `src/utils.ts`, `EmailHtmlView.tsx`, `EmailReader.tsx` | `.agents/context/frontend.md` |
| Gmail/OAuth/attachments | `src-tauri/src/gmail.rs`, `auth.rs` | `.agents/context/backend.md` |
| Local accounts, cache, contacts, threads | `src-tauri/src/db.rs` | `.agents/context/backend.md` |
| App controls, tray, Windows startup | `settings.rs`, `src/components/SettingsPanel.tsx` | `.agents/context/backend.md` |
| Build, updater, version, release | `package.json`, `src-tauri/tauri.conf.json`, `.github/workflows/release.yml` | `.agents/context/release.md` |

## Decision boundary

Implement contained bug fixes and explicitly requested UI/code changes. Ask before changing product behavior or scope: account model, authentication/permissions, storage schema or data deletion, mail sync/sending semantics, security/privacy, external services, dependencies, or release/publishing. Never read, print, or commit `.env` files or credentials.

For user-visible copy, keep English and Turkish locale coverage aligned in `src/i18n.ts`. Preserve the existing Gmail-only product scope unless the user explicitly requests otherwise.

## Design system

- Build new UI and update existing app chrome with the semantic CSS tokens in `src/index.css` and the shared recipes in `src/theme.ts`.
- Do not add raw application colors, arbitrary font sizes, spacing, radii, shadows, or status colors when an appropriate token or shared recipe exists. If a reusable value is missing, add a semantic token first, then consume it.
- Prefer names based on purpose (`surface`, `text`, `border`, `action`, `status`) rather than a literal color or one-off component name. Keep theme-aware actions on `--app-accent`, `--app-accent-hover`, `--app-accent-soft`, and `--app-accent-shadow`.
- Treat email HTML, third-party brand artwork, and the standalone notification document as boundaries: preserve external content styles and keep `notification.html` tokens locally mapped to the app design system.
- Token-only refactors should preserve the current rendered values. For UI changes, report whether the appearance intentionally changed and list the manual visual checks performed or still required.

## Verify proportionally

- Frontend change: `npm run build`
- Rust change: `cargo check` from `src-tauri`
- Release: follow `.agents/context/release.md`; do not tag, push, or publish without explicit approval.

For a release commit, use the version as a short title and a concise Markdown body with user-facing bullet points, mirroring the release notes. Do not rewrite an already-published release commit merely to improve its message.

Keep docs in `.agents/context/` factual and compact. Update only the relevant map when a structural change would make this routing inaccurate.

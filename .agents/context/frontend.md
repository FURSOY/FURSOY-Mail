# Frontend map

`src/App.tsx` is the orchestration shell: account/token state, sync scheduling, Tauri invocations, selection, mail actions, updater UI, and panel composition. Locate a named `handle*`, `loadEmails`, `syncAccountWithAutoRefresh`, or relevant effect with `rg` before opening a narrow range.

| Area | Files |
| --- | --- |
| App-wide contracts | `src/types.ts`, `src/i18n.ts`, `src/theme.ts` |
| Email normalization/render safety | `src/utils.ts`, `components/EmailHtmlView.tsx`, `components/EmailReader.tsx` |
| Navigation/list | `components/Sidebar.tsx`, `components/EmailList.tsx` |
| Compose/reply/delete confirmation | `components/ComposeModal.tsx`, `components/ConfirmModal.tsx` |
| Preferences | `components/SettingsPanel.tsx` |
| Global and app styling | `src/index.css`, `src/App.css` |

Important: email HTML and remote-image handling are security-sensitive. Keep sanitization, URL validation, size caps, iframe messaging, and proxy behavior intact unless the user approves a behavior/security change. Use `src/i18n.ts` for new interface strings; do not add a second state store unless asked.

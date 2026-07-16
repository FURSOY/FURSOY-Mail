# Frontend map

`src/App.tsx` is the remaining composition shell: navigation, mailbox list/cache state, preferences, window events, and panel composition. Locate a named handler or relevant effect with `rg` before opening a narrow range. Account/token state, sync scheduling, updater, mail actions, and reader/thread loading live in `src/hooks/`; typed Tauri commands live in `src/tauriApi.ts`.

| Area | Files |
| --- | --- |
| App-wide contracts | `src/types.ts`, `src/i18n.ts`, `src/theme.ts` |
| Accounts, sync, updater, actions, reader | `src/hooks/useAccounts.ts`, `useMailSync.ts`, `useUpdater.ts`, `useMailActions.ts`, `useMailReader.ts` |
| Typed Tauri boundary | `src/tauriApi.ts` |
| Email normalization/render safety | `src/utils.ts`, `components/EmailHtmlView.tsx`, `components/EmailReader.tsx` |
| Navigation/list | `components/Sidebar.tsx`, `components/EmailList.tsx` |
| Compose/reply/delete confirmation | `components/ComposeModal.tsx`, `components/ConfirmModal.tsx` |
| Preferences | `components/SettingsPanel.tsx` |
| Global and app styling | `src/index.css`, `src/App.css` |

Important: email HTML and remote-image handling are security-sensitive. Keep sanitization, URL validation, size caps, iframe messaging, and proxy behavior intact unless the user approves a behavior/security change. Use `src/i18n.ts` for new interface strings; do not add a second state store unless asked.

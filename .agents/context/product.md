# Product facts

- FURSOY Mail is a Windows-focused Tauri desktop client with a dark, three-pane mail UI.
- The implemented provider is Gmail/Google OAuth. Multiple Google accounts are supported; Outlook is not implemented.
- Rust owns OAuth, Gmail HTTP calls, SQLite cache, native notifications, Windows startup/tray/window state, and attachment writes.
- React owns application state and presents cached/synced mail through Tauri commands.
- Credentials are loaded from environment/keyring paths; never place them in source, docs, commits, or tool output.

Current product boundaries are deliberate. Treat a new mail provider, account-model change, altered sync cadence, data-retention rule, or new external integration as a product decision and ask first.

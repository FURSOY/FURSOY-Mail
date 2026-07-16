# Backend map

`src-tauri/src/lib.rs` registers every frontend-callable command and app lifecycle behavior. When adding or renaming a command, update its Rust implementation, the registration list, and the matching frontend invocation together.

| Area | Files |
| --- | --- |
| Google OAuth and token refresh | `auth.rs` |
| Gmail sync, labels, MIME, sending, attachments | `gmail.rs` |
| SQLite cache, accounts, contacts, threads | `db.rs` |
| App controls and Windows launch-at-startup registry | `settings.rs` |
| Native notifications and window focus | `notify.rs` |
| Persisted window geometry | `window_state.rs` |
| Remote email-image proxy | `img_proxy.rs` |
| Rust regression tests | Inline `#[cfg(test)]` modules beside the owning code; run with `npm run test:rust` or `cargo test` from `src-tauri` |

The database is user data and the Gmail methods have external effects. Ask before migrations, retention/deletion changes, OAuth scope changes, or altered send/sync semantics. Avoid logging tokens, message bodies, or attachment contents.

Gmail HTTP tests use a local test server; DB tests use isolated in-memory SQLite databases. Tests must not require real Google credentials or touch the user's application database.

# Testing

- `npm test`: frontend unit and mocked Tauri-boundary tests.
- `npm run test:watch`: rerun frontend tests while developing.
- `npm run test:rust`: Rust Gmail, sync, database, attachment, account-isolation, and image-proxy tests.
- `npm run test:all`: complete frontend and Rust suite.
- `npm run build`: TypeScript and production bundle verification.

Automated tests never use real Google credentials or the user's application database. Gmail HTTP behavior uses a local test server, SQLite tests use isolated in-memory databases, and frontend Tauri calls use a mocked command boundary.

Before a release, manually smoke-test two real accounts: initial sync, account switching, unread counts, one new-mail notification per message, archive, trash, restore, send, and reply.

## Improvements

- Added a consistent draggable window title bar to the first-run onboarding screen.
- Added an in-app privacy-policy link and clearer local-data disclosures.
- Opened `mailto:` links directly in the FURSOY Mail compose window.
- Added Windows default-mail-app registration and settings integration.
- Reworked the README around installation, product features, permissions, and privacy.

## Security and reliability

- Hardened Google OAuth with a public-client PKCE flow, narrower permissions, safer token migration, and rollback on partial failures.
- Enforced account and window boundaries for mail, attachment, settings, notification, and account operations.
- Hardened outbound headers, attachment validation, email rendering, external links, file paths, and installer redirects against untrusted input.
- Made sync, cache, account removal, notification, tray, and local file failure paths recoverable and transactional where applicable.
- Added uncertain-send protection: connection loss no longer triggers an automatic resend, and Sent mail is checked by a unique message ID before the message can be retried.
- Added atomic settings, window-state, and attachment writes to avoid partial local files.
- Expanded frontend and Rust regression coverage for authentication, authorization, sync isolation, retries, attachment safety, and uncertain sends.

## Fixes

- Fixed the onboarding content appearing vertically offset in the window.
- Added a cancel action when Google sign-in is left waiting after the browser is closed.
- Handled Google authorization cancellation without leaving the app stuck in a loading state.
- Changed the local OAuth completion and cancellation pages to English.

## Improvements

- Added notification delivery modes for all mail, OTP-only alerts, or no notifications.
- Reorganized settings into clearer groups for accounts, appearance, notifications, sync, and mail data.
- Added reliable copy feedback to OTP notifications and improved multi-account notification layout.
- Added safer clipboard behavior: copied mail text is plain text and pasted images are sent as attachments.
- Centralized theme and language foundations for more consistent interface updates.

## Reliability and maintenance

- Added bounded retry, exponential backoff, jitter, and rate-limit handling for Gmail sync requests.
- Improved sync, unread-count, trash, account removal, and attachment cleanup behavior.
- Split application orchestration into focused account, sync, updater, reader, and mail-action modules.
- Added frontend and Rust regression tests for critical mail, database, localization, and API flows.

## Fixes

- Prevented old mail from repeatedly producing notifications after startup or resync.
- Fixed notification avatars, copy-button positioning, and copy success/error states.
- Fixed copied email formatting from carrying white backgrounds into the compose editor.
- Localized attachment download success messages in Turkish and English.

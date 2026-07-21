## Improvements

- Added Gmail-backed draft autosave, editing, deletion, and account-aware draft selection to the compose window.
- Added a scrollable draft list that loads additional drafts in pages for large mailboxes.
- Kept the composer open and cleared after a draft is deleted so a new message can be started immediately.

## Reliability

- Preserved edits when an existing draft is completely cleared before closing or switching drafts.
- Reconciled uncertain first-time draft saves by their unique message ID to prevent duplicate drafts.
- Sent saved drafts with Gmail's atomic draft-send operation so a successfully sent message cannot remain as a stale draft.
- Kept draft operations scoped to the selected Google account and validated draft identifiers and pagination tokens.

## Fixes

- Fixed saved drafts not always reopening with their formatted HTML and attachments.
- Fixed draft cleanup and autosave races around sending, account switching, and queued saves.

## Improvements

- Improved background synchronization, notifications, attachment handling, and settings updates under concurrent activity.
- Added bounded processing for remote email images, pending notifications, and long-lived mail caches.

## Reliability

- Prevented duplicate sends and conflicting read/unread, sync, and settings operations.
- Cancelled obsolete account backfills, attachment reads, timers, and event listeners when their owners close or change.
- Guaranteed temporary-file cleanup errors are reported and limited resource queues to prevent runaway memory or task growth.

## Fixes

- Fixed stale attachment previews and notification-window startup races.
- Fixed repeated attachment selections bypassing total-size checks; messages now allow up to 100 attachments.
- Fixed delayed window-state saves accumulating during rapid resize and state transitions.

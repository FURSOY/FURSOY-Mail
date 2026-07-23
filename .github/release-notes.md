## Improvements

- Reduced memory growth during long mail sessions by bounding cached message and reader state.
- Improved thread scrolling stability while messages load, selections change, and thread content updates.

## Reliability and Security

- Prevented stale reader work from accumulating or updating mail state after the active message changes.
- Removed the unused shadcn CLI and its transitive packages from production dependencies, reducing the install and audit surface without changing the interface.

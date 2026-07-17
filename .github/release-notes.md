## Improvements

- Added a consistent draggable window title bar to the first-run onboarding screen.
- Added an in-app privacy-policy link and clearer local-data disclosures.
- Opened `mailto:` links directly in the FURSOY Mail compose window.
- Reworked the README around installation, product features, permissions, and privacy.

## Fixes

- Fixed the onboarding content appearing vertically offset in the window.
- Added a cancel action when Google sign-in is left waiting after the browser is closed.
- Handled Google authorization cancellation without leaving the app stuck in a loading state.
- Reduced Google OAuth permissions by removing the redundant `gmail.send` scope.
- Changed the local OAuth completion and cancellation pages to English.

# FURSOY Mail

FURSOY Mail is a Tauri 2 desktop mail client.

## Windows installer

Use the NSIS setup file for distribution:

```powershell
npm ci
npm run release:windows
```

The installer is created under:

```text
src-tauri/target/release/bundle/nsis/
```

Do not distribute the raw `src-tauri/target/release/fursoy-mail.exe` file. That executable expects system prerequisites such as WebView2 to already exist. The `-setup.exe` installer installs the app and includes the Microsoft WebView2 offline installer, so it can work on clean Windows machines without a separate WebView2 download.

The setup file is intentionally larger because `src-tauri/tauri.conf.json` uses:

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

## Local development prerequisites

For building from source on Windows, install these developer tools first:

- Node.js 22 or newer
- Rust stable toolchain
- Microsoft C++ Build Tools

For Google login in local builds, create `src-tauri/.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

GitHub Actions reads the same values from repository secrets and publishes the NSIS setup file plus `latest.json` for the updater.

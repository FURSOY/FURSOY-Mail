"use client";

import { useEffect, useState } from "react";

const releasesUrl =
  "https://api.github.com/repos/FURSOY/FURSOY-Mail/releases/latest";
const fallbackUrl =
  "https://github.com/FURSOY/FURSOY-Mail/releases/latest";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Release = {
  assets: ReleaseAsset[];
};

export default function DownloadPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    async function startDownload() {
      try {
        const response = await fetch(releasesUrl, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) throw new Error("Release could not be loaded.");

        const release = (await response.json()) as Release;
        const installer =
          release.assets.find(
            (asset) => asset.name === "FURSOY.Mail.Windows.x64-setup.exe",
          ) ??
          release.assets.find((asset) =>
            /FURSOY\.Mail.*x64-setup\.exe$/i.test(asset.name),
          );

        if (!installer) throw new Error("Installer could not be found.");
        window.location.replace(installer.browser_download_url);
      } catch {
        setFailed(true);
      }
    }

    void startDownload();
  }, []);

  return (
    <main className="download-page">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span>FURSOY Mail</span>
      </div>
      <h1>Your download is starting.</h1>
      <p className="download-status">
        {failed ? (
          <>
            The automatic download could not start.{" "}
            <a href={fallbackUrl}>Open the latest release</a>.
          </>
        ) : (
          "Finding the latest Windows installer…"
        )}
      </p>
    </main>
  );
}

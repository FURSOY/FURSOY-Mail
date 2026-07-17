import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { absolute: "FURSOY Mail — Verification codes, one click away" },
  description:
    "A lightweight, local-first Gmail client for Windows that detects verification codes and lets you copy them from notifications.",
  alternates: { canonical: "/" },
};

export default function Home() {
  const softwareApplication = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "FURSOY Mail",
    applicationCategory: "CommunicationApplication",
    operatingSystem: "Windows 10, Windows 11",
    description:
      "A lightweight, local-first Gmail client that detects verification codes and lets users copy them from notifications.",
    downloadUrl: "https://fursoy.com/download",
    isAccessibleForFree: true,
    license: "https://github.com/FURSOY/FURSOY-Mail",
    codeRepository: "https://github.com/FURSOY/FURSOY-Mail",
  };

  return (
    <>
      <main className="home">
        <div className="brand" aria-label="FURSOY Mail">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>FURSOY Mail</span>
        </div>

        <h1>
          Verification codes.
          <br />
          <span>One click away.</span>
        </h1>
        <p className="lead">
          A lightweight Gmail client for Windows that finds verification codes
          and puts them directly in your notifications.
        </p>

        <a className="download" href="/download">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />
          </svg>
          Download for Windows
        </a>
        <p className="requirements">Windows 10 and 11 · Gmail</p>

        <div className="facts" aria-label="Product details">
          <span>~5 MB installer</span>
          <span>Local-first</span>
          <span>No telemetry</span>
          <a href="https://github.com/FURSOY/FURSOY-Mail">Open source</a>
        </div>
      </main>

      <footer>
        <span>© 2026 FURSOY</span>
        <div>
          <a href="/privacy">Privacy</a>
          <a href="https://github.com/FURSOY/FURSOY-Mail">GitHub</a>
        </div>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplication) }}
      />
    </>
  );
}

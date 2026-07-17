import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How FURSOY Mail accesses, processes, stores, and protects Google user data.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <article className="policy">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden="true">M</span>
        <span>FURSOY Mail</span>
      </Link>

      <h1>Privacy Policy</h1>
      <p className="updated">Last updated: July 17, 2026</p>

      <p>
        FURSOY Mail is a desktop Gmail client focused on fast notifications and
        one-click copying of verification codes. This policy explains what data
        the app accesses, why it accesses that data, and where it is stored.
      </p>

      <h2>Data the app accesses</h2>
      <p>When you connect a Google account, FURSOY Mail can access:</p>
      <ul>
        <li>your email address, display name, and profile picture;</li>
        <li>Gmail message content and metadata needed by app features;</li>
        <li>attachments that you choose to view or download;</li>
        <li>mail actions that you explicitly request.</li>
      </ul>

      <h2>How data is used</h2>
      <p>
        Google user data is used only to provide FURSOY Mail features, including
        mail synchronization, notifications, verification-code detection,
        message rendering, attachments, and mail actions you initiate.
      </p>
      <p>
        FURSOY Mail does not sell user data, use it for advertising, or collect
        crash reports, diagnostics, usage statistics, or telemetry.
      </p>
      <p>
        Use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements.
      </p>

      <h2>Storage and transfers</h2>
      <ul>
        <li>FURSOY Mail does not operate a server that stores mailbox data.</li>
        <li>OAuth tokens are stored in the operating system credential store.</li>
        <li>Mail data and preferences are stored locally on your device.</li>
        <li>The app connects directly to Google for Gmail and authentication.</li>
        <li>Remote images can contact their original third-party host when allowed.</li>
        <li>Updates are checked and downloaded through GitHub Releases.</li>
      </ul>

      <h2>Retention and deletion</h2>
      <p>
        Local mail data remains until you remove the account, reset the local
        mailbox, or remove the app data. Removing an account deletes its local
        cache and stored credentials. It does not delete messages from Gmail
        unless you separately request a Gmail deletion action.
      </p>

      <h2>Security</h2>
      <p>
        FURSOY Mail uses Google OAuth and never asks for your Google password.
        Tokens are kept in the operating system credential store. No local
        storage or network transmission method can be guaranteed completely secure.
      </p>

      <h2>Changes and contact</h2>
      <p>
        Material changes are reflected by updating the date above. Privacy
        questions can be submitted through the{" "}
        <a href="https://github.com/FURSOY/FURSOY-Mail/issues">
          FURSOY Mail issue tracker
        </a>
        .
      </p>
    </article>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://fursoy.com"),
  title: {
    default: "FURSOY Mail — Verification codes, one click away",
    template: "%s — FURSOY Mail",
  },
  description:
    "A lightweight, local-first Gmail client for Windows that detects verification codes and lets you copy them from notifications.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    siteName: "FURSOY Mail",
    title: "FURSOY Mail",
    description:
      "Verification codes from Gmail, ready to copy from a Windows notification.",
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "FURSOY Mail",
    description:
      "Verification codes from Gmail, ready to copy from a Windows notification.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

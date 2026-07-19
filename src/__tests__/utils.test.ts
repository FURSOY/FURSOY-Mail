import { describe, expect, it } from "vitest";
import {
  buildRenderableEmailHtml,
  extractVerificationCode,
  isAuthFailure,
  isNoUpdateError,
  minutesFromTime,
  normalizeComposerLinkUrl,
  parseMailtoUrl,
  resolveEmailUrl,
  sanitizeComposerHtml,
  sanitizeEmailHtml,
} from "../utils";

describe("error classification", () => {
  it("recognizes transient authentication failures", () => {
    expect(isAuthFailure(new Error("401 Unauthorized"))).toBe(true);
    expect(isAuthFailure("invalid_grant")).toBe(true);
  });

  it("does not treat an insufficient-scope response as an expired token", () => {
    expect(isAuthFailure("403 Request had insufficient authentication scopes")).toBe(false);
  });

  it("recognizes updater responses that mean there is no newer version", () => {
    expect(isNoUpdateError("204 No update available")).toBe(true);
    expect(isNoUpdateError("connection timed out")).toBe(false);
  });
});

describe("verification code extraction", () => {
  it("extracts an English verification code", () => {
    expect(extractVerificationCode({
      subject: "Your verification code",
      snippet: "Use code 123456 to sign in",
      body_html: "<p>Use code <strong>123456</strong> to sign in.</p>",
    })).toBe("123456");
  });

  it("extracts a Turkish verification code", () => {
    expect(extractVerificationCode({
      subject: "Hesap doğrulama",
      snippet: "Doğrulama kodunuz: 654321",
      body_html: "",
    }, "balanced", "tr")).toBe("654321");
  });

  it("rejects ordinary order and invoice numbers", () => {
    expect(extractVerificationCode({
      subject: "Invoice 123456",
      snippet: "Your order number is 123456",
      body_html: "<p>Thank you for your order.</p>",
    })).toBeNull();
    expect(extractVerificationCode({
      subject: "[123456]",
      snippet: "Verification code",
      body_html: "",
    }, "off")).toBeNull();
  });
});

describe("email HTML safety", () => {
  it("keeps received HTML inert at the privileged composer boundary", () => {
    const sanitized = sanitizeComposerHtml(
      '<img src=x onerror="alert(1)"><script>alert(2)</script><b>Safe</b>',
    );

    expect(sanitized).toContain("Safe");
    expect(sanitized).not.toMatch(/onerror|script|<img/i);
  });

  it("removes executable content and event handlers", () => {
    const sanitized = sanitizeEmailHtml(
      '<html><head><style>.mail{color:red}</style></head><body><a href="javascript:alert(1)" onclick="alert(2)">Open</a><script>alert(3)</script><iframe>hidden</iframe></body></html>',
      "",
    );

    expect(sanitized).toContain("<style>.mail{color:red}</style>");
    expect(sanitized).toContain("Open");
    expect(sanitized).not.toMatch(/javascript:|onclick|<script|<iframe/i);
  });

  it("proxies remote images when loading is allowed", () => {
    const rendered = buildRenderableEmailHtml(
      '<img src="https://images.example.test/banner.png">',
      "",
      "full",
      true,
    );

    expect(rendered).toContain("http://mailimg.localhost/?url=");
    expect(rendered).not.toContain('src="https://images.example.test');
  });
});

describe("small input helpers", () => {
  it("only permits supported email link protocols", () => {
    expect(resolveEmailUrl("/mail/u/0/#inbox")).toBe("https://mail.google.com/mail/u/0/#inbox");
    expect(resolveEmailUrl("mailto:user@example.test")).toBe("mailto:user@example.test");
    expect(resolveEmailUrl("javascript:alert(1)")).toBeNull();
  });

  it("normalizes composer links and rejects executable schemes", () => {
    expect(normalizeComposerLinkUrl("example.test/path")).toBe("https://example.test/path");
    expect(normalizeComposerLinkUrl("mailto:user@example.test")).toBe("mailto:user@example.test");
    expect(normalizeComposerLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeComposerLinkUrl("https://example.test/\nBcc:test@example.test")).toBeNull();
  });

  it("parses mailto links into a compose draft", () => {
    expect(parseMailtoUrl("mailto:user@example.test?subject=Hello%20there&body=First%20line%0ASecond%20line")).toEqual({
      to: "user@example.test",
      subject: "Hello there",
      body: "First line\nSecond line",
    });
    expect(parseMailtoUrl("https://example.test")).toBeNull();
  });

  it("parses and clamps quiet-hour times", () => {
    expect(minutesFromTime("22:30")).toBe(1_350);
    expect(minutesFromTime("29:90")).toBe(1_439);
    expect(minutesFromTime("invalid")).toBe(0);
  });
});

import type { OtpMode, RenderMode, MailZoom, MailViewMode, AppControls } from "./types";
import { type ThemePresetName, themePresets } from "./theme";

export const LARGE_BODY_RENDER_LIMIT = 4_000_000;
export const MAX_INLINE_DATA_URI = 4_000_000;
export const FIXED_LAYOUT_MIN_WIDTH = 460;
export const IMAGE_PROXY_BASE = "http://mailimg.localhost/?url=";
export const MAX_LABEL_CACHE = 5;
export const STARTUP_NETWORK_DELAY_MS = 5000;
export const STARTUP_UPDATE_DELAY_MS = 9000;
export const MAIL_TABS = new Set(["inbox", "sent", "archive", "spam", "trash"]);
export const AUTH_RELOGIN_MESSAGE = "Oturum yenilenemedi. Lütfen tekrar giriş yapın.";
export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function isNoUpdateError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /no update|not available|up to date|guncel|güncel|204/.test(message);
}

export function isAuthFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /401|unauthorized|invalid_grant|invalid credentials|unauthenticated|autherror|expected oauth 2 access token|no refresh token|oturum yenilenemedi|oturum bilgisi bulunamad/.test(message);
}

export function byteLength(text: string): number {
  return new Blob([text]).size;
}

export function decodeBasicHtmlEntities(html: string): string {
  const codeToChar = (code: number) => {
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return " ";
    try {
      return String.fromCodePoint(code);
    } catch {
      return " ";
    }
  };
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;#(\d+);/gi, (_, n) => codeToChar(Number(n)))
    .replace(/&amp;#x([0-9a-f]+);/gi, (_, h) => codeToChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codeToChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codeToChar(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function stripHtml(html: string): string {
  const decoded = decodeBasicHtmlEntities(html);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text: string): string {
  return decodeBasicHtmlEntities(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeEmailHtml(html: string, fallback: string): string {
  const source = (html || "").trim();
  if (!source) {
    return `<div class="plain-text">${escapeHtml(fallback || "").replace(/\n/g, "<br/>")}</div>`;
  }

  const styles = (source.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n");
  const cleaned = source
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<html\b[^>]*>/gi, "")
    .replace(/<\/html>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|action)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "")
    .replace(/\s(href|src|action)\s*=\s*javascript:[^\s>]*/gi, "");

  const bodyMatch = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return `${styles}${bodyMatch ? bodyMatch[1] : cleaned}`;
}

export function proxifyEmailImages(html: string): string {
  return html
    .replace(
      /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
      (_match, prefix, quote, url) => `${prefix}${quote}${IMAGE_PROXY_BASE}${encodeURIComponent(url)}${quote}`
    )
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\sloading\s*=\s*["']lazy["']/gi, "");
}

export function buildRenderableEmailHtml(html: string, fallback: string, mode: RenderMode): string {
  if (mode === "simple" || byteLength(html) > LARGE_BODY_RENDER_LIMIT) {
    const plain = stripHtml(html || fallback);
    return `<div class="plain-text">${escapeHtml(plain || fallback || "").replace(/\n/g, "<br/>")}</div>`;
  }

  const sanitized = sanitizeEmailHtml(html, fallback).replace(
    new RegExp(`\\s(src|href)\\s*=\\s*(["'])data:([^"']{${MAX_INLINE_DATA_URI},})\\2`, "gi"),
    ""
  );
  return proxifyEmailImages(sanitized);
}

export function normalizeOtpPlaintext(text: string): string {
  let s = text.replace(/[​-‍﻿⁠]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\b(?:\d[\s ]){3,11}\d\b/g, (m) => m.replace(/[\s ]+/g, ""));
  s = s.replace(/\b(\d{3,4})[\s-](\d{3,4})\b/g, (m, g1, g2) => {
    if (g1.length + g2.length >= 4 && g1.length + g2.length <= 8) return g1 + g2;
    return m;
  });
  return s;
}

const NEGATIVE_CONTEXT_RE =
  /(?:po box|box|parkway|amphitheatre|tl|usd|eur|\$|€|tel|phone|fax|adres|address|street|sokak|cadde|mahalle|bulvar|kimlik|id|no\.|numarası)/i;

const STRONG_OTP_CONTEXT_RE =
  /(?:verification|verify|dogrulama|doğrulama|confirm|confirmation|onay|login|sign[\s-]?in|oturum|authentication|auth|two[\s-]?factor|2fa|mfa|one[\s-]?time|tek\s*kullanım|tek\s*kullanim)[\s\w.,:;'"()/-]{0,36}(?:code|kod|kodu|pin|otp|passcode|password|sifre|şifre)|(?:code|kod|kodu|pin|otp|passcode|verification code|security code|login code|confirmation code|one[\s-]?time password|one[\s-]?time code|2fa code|mfa code|sifre|şifre)/i;

const DIRECT_OTP_PREFIX_RE =
  /(?:code|kod|kodu|pin|otp|passcode|verification code|security code|login code|confirmation code|sifre|şifre)\s*(?:is|:|-|=|→)?\s*$/i;

const BROAD_NEGATIVE_CONTEXT_RE =
  /(?:iso(?:\/iec)?|certified|certificate|certification|standard|platform|developers?|community|experts?|subscribers?|followers?|members?|users?|customers?|blog|article|release|changelog|version|copyright|po box|box|parkway|amphitheatre|tl|try|usd|eur|\$|€|tel|phone|fax|adres|address|street|sokak|cadde|mahalle|bulvar|kimlik|id|no\.|numarası|numarasi|invoice|order|ticket|case|ref|reference)/i;

const METRIC_SUFFIX_RE = /^\d+(?:\.\d+)?[kmb]$/i;
const YEAR_OR_STANDARD_RE = /^(?:19|20)\d{2}$|^27001$|^27701$|^22301$|^9001$|^42001$/;

export function extractVerificationCode(
  email: { subject: string; snippet: string; body_html: string },
  mode: OtpMode = "balanced"
): string | null {
  if (mode === "off") return null;
  const raw = `${email.subject} ${email.snippet} ${stripHtml(email.body_html)}`;
  const text = normalizeOtpPlaintext(raw);

  const candidates: { code: string; score: number; index: number }[] = [];

  const numRegex = /\b(\d{4,8})\b/g;
  let m;
  while ((m = numRegex.exec(text)) !== null) {
    candidates.push({ code: m[1], score: 0, index: m.index });
  }

  const alphaNumRegex = /\b([A-Z]+[0-9]+[A-Z0-9]*|[0-9]+[A-Z]+[A-Z0-9]*)\b/g;
  while ((m = alphaNumRegex.exec(text)) !== null) {
    if (m[1].length >= 4 && m[1].length <= 10 && !METRIC_SUFFIX_RE.test(m[1])) {
      candidates.push({ code: m[1], score: 0, index: m.index });
    }
  }

  if (candidates.length === 0) return null;

  for (const c of candidates) {
    if (METRIC_SUFFIX_RE.test(c.code) || YEAR_OR_STANDARD_RE.test(c.code)) {
      c.score = -999;
      continue;
    }

    const windowStart = Math.max(0, c.index - 140);
    const windowEnd = Math.min(text.length, c.index + c.code.length + 140);
    const contextStr = text.slice(windowStart, windowEnd);
    const before = text.slice(Math.max(0, c.index - 60), c.index);
    const after = text.slice(c.index + c.code.length, Math.min(text.length, c.index + c.code.length + 60));

    if (STRONG_OTP_CONTEXT_RE.test(contextStr)) c.score += 80;

    const directPrefix = new RegExp(`(?:code|kod|kodu|verification|doğrulama|otp|pin)[:\\s\\-]*${c.code}`, "i");
    const hasDirectOtpPrefix = directPrefix.test(contextStr) || DIRECT_OTP_PREFIX_RE.test(before);
    if (hasDirectOtpPrefix) c.score += 140;
    if (mode === "strict" && !hasDirectOtpPrefix) c.score -= 100;
    if (/(?:expires?|valid|dakika|minute|min|within|use|enter|gir|kullan)/i.test(contextStr)) {
      c.score += 25;
    }

    if (NEGATIVE_CONTEXT_RE.test(contextStr) || BROAD_NEGATIVE_CONTEXT_RE.test(contextStr)) c.score -= 120;
    if (/^[A-Z]{2,}\d+$/.test(c.code) && /(?:version|release|build|ticket|issue|case|ref)/i.test(contextStr)) c.score -= 120;
    if (/^[A-Z0-9]{4,10}$/.test(c.code) && /[A-Z]/.test(c.code) && !STRONG_OTP_CONTEXT_RE.test(contextStr)) c.score -= 80;
    if (/^\d+$/.test(c.code) && /[%+]/.test(before.slice(-2) + after.slice(0, 2))) c.score -= 100;
    if (/^\d+$/.test(c.code) && /(?:\bISO(?:\/IEC)?\s*$|\bISO(?:\/IEC)?\s+)/i.test(before.slice(-16) + after.slice(0, 16))) c.score -= 160;

    if (c.code.length === 6 && /^\d+$/.test(c.code)) c.score += 20;
    else if (/^\d+$/.test(c.code) && c.code.length === 8) c.score += 10;
    else if (/^\d+$/.test(c.code) && c.code.length === 4) c.score -= 15;

    c.score -= (c.index / text.length) * 10;

    if (c.code.length === 4 && (c.code.startsWith("19") || c.code.startsWith("20"))) {
      c.score -= 40;
    }
  }

  const validCandidates = candidates.filter(c => c.score >= (mode === "strict" ? 140 : 70));
  if (validCandidates.length === 0) return null;

  validCandidates.sort((a, b) => b.score - a.score);
  return validCandidates[0].code;
}

export function resolveEmailUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("#")) return null;
  try {
    const resolved = new URL(url, "https://mail.google.com/").href;
    return /^(https?:|mailto:|tel:)/i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function findEmailUrl(eventTarget: EventTarget | null): string | null {
  if (!eventTarget || typeof (eventTarget as unknown as Record<string, unknown>).closest !== "function") return null;
  const node = eventTarget as Element;
  const link = node.closest("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
  if (link) return resolveEmailUrl(link.getAttribute("href") || link.href);

  const button = node.closest("button, input[type='button'], input[type='submit'], [role='button']") as HTMLElement | null;
  const form = button?.closest("form") as HTMLFormElement | null;
  return resolveEmailUrl(
    button?.getAttribute("formaction") ||
    button?.getAttribute("data-href") ||
    button?.getAttribute("data-url") ||
    form?.getAttribute("action")
  );
}

export function buildEmailSrcDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <style>
      html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
      * { box-sizing: border-box; }
      .mail-root {
        display: block; width: 100%; min-width: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px; line-height: 1.6; color: #1a1a1a;
      }
      .mail-root > .plain-text { padding: 20px 24px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 720px; }
      img, video { height: auto; }
      a { color: #2563eb; }
      ::selection { background: rgba(59, 130, 246, 0.25); }
    </style></head>
    <body><div class="mail-root">${html}</div></body></html>`;
}

export function readMailZoom(): MailZoom {
  const saved = localStorage.getItem("fursoy_mail_zoom");
  if (!saved || saved === "fit") return "fit";
  const value = parseFloat(saved);
  return Number.isFinite(value) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) : "fit";
}

export function getAutoMailViewMode(width: number): MailViewMode {
  if (width < 900) return "inbox-first";
  return "split";
}

export function readThemePreset(): ThemePresetName {
  const saved = localStorage.getItem("fursoy_theme_preset");
  return saved && saved in themePresets ? (saved as ThemePresetName) : "blue";
}

export function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(part => parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

export function isInQuietHours(controls: AppControls): boolean {
  if (!controls.quietHoursEnabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesFromTime(controls.quietHoursStart);
  const end = minutesFromTime(controls.quietHoursEnd);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("tr-TR", { month: "short", day: "numeric" });
}

export function formatDateFull(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString("tr-TR", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

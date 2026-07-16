import { describe, expect, it } from "vitest";
import { locales } from "../i18n";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" ? keyPaths(child, path) : [path];
  });
}

describe("locale contract", () => {
  it("keeps English and Turkish translation keys aligned", () => {
    expect(keyPaths(locales.tr).sort()).toEqual(keyPaths(locales.en).sort());
  });
});

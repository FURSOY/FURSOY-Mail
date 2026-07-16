import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { tauriApi } from "../tauriApi";

const invokeMock = vi.mocked(invoke);

describe("typed Tauri boundary", () => {
  beforeEach(() => invokeMock.mockClear());

  it("keeps two-account sync credentials isolated", async () => {
    await tauriApi.syncEmails("account-a", "token-a", false);
    await tauriApi.syncEmails("account-b", "token-b", true);

    expect(invokeMock.mock.calls).toEqual([
      ["sync_emails", { accountId: "account-a", accessToken: "token-a", force: false }],
      ["sync_emails", { accountId: "account-b", accessToken: "token-b", force: true }],
    ]);
  });

  it("scopes destructive mail actions to both account and message", async () => {
    await tauriApi.trashEmail("account-a", "token-a", "shared-message-id");
    await tauriApi.permanentlyDelete("account-b", "token-b", "shared-message-id");

    expect(invokeMock.mock.calls).toEqual([
      ["trash_email", { accountId: "account-a", accessToken: "token-a", messageId: "shared-message-id" }],
      ["permanently_delete", { accountId: "account-b", accessToken: "token-b", messageId: "shared-message-id" }],
    ]);
  });

  it("preserves all-account and cursor paging parameters", async () => {
    await tauriApi.getEmailsByLabel({
      label: "inbox",
      accountId: null,
      limit: 100,
      beforeDate: 123,
      beforeAccountId: "account-a",
      beforeId: "message-a",
    });

    expect(invokeMock).toHaveBeenCalledWith("get_emails_by_label", {
      label: "inbox",
      accountId: null,
      limit: 100,
      beforeDate: 123,
      beforeAccountId: "account-a",
      beforeId: "message-a",
    });
  });
});

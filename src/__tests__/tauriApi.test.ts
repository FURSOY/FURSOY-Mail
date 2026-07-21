import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { tauriApi } from "../tauriApi";

const invokeMock = vi.mocked(invoke);

describe("typed Tauri boundary", () => {
  beforeEach(() => invokeMock.mockClear());

  it("keeps credentials behind the Rust boundary during sync", async () => {
    await tauriApi.syncEmails("account-a", false);
    await tauriApi.syncEmails("account-b", true);

    expect(invokeMock.mock.calls).toEqual([
      ["sync_emails", { accountId: "account-a", force: false }],
      ["sync_emails", { accountId: "account-b", force: true }],
    ]);
  });

  it("scopes trash actions to both account and message", async () => {
    await tauriApi.trashEmail("account-a", "shared-message-id");

    expect(invokeMock.mock.calls).toEqual([
      ["trash_email", { accountId: "account-a", messageId: "shared-message-id" }],
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

  it("verifies an uncertain send by account and generated message ID", async () => {
    await tauriApi.verifySentMessage(
      "account-a",
      "<fursoy-0123456789abcdef@mail.invalid>",
    );

    expect(invokeMock).toHaveBeenCalledWith("verify_sent_message", {
      accountId: "account-a",
      messageId: "<fursoy-0123456789abcdef@mail.invalid>",
    });
  });

  it("passes optional Cc and Bcc recipients through the typed send boundary", async () => {
    await tauriApi.sendEmail({
      accountId: "account-a",
      to: "to@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      subject: "Status",
      body: "<p>Hello</p>",
      attachments: null,
    });

    expect(invokeMock).toHaveBeenCalledWith("send_email", {
      accountId: "account-a",
      to: "to@example.test",
      cc: "copy@example.test",
      bcc: "hidden@example.test",
      subject: "Status",
      body: "<p>Hello</p>",
      attachments: null,
    });
  });
});

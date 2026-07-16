import { invoke } from "@tauri-apps/api/core";
import type { Account, AppControls, AttachmentPayload, AuthInfo, EmailSummary } from "./types";

export interface MailboxDownloadStatus {
  running: boolean;
  pending: boolean;
  state: "waiting" | "running" | "paused" | "error" | "completed" | "relogin_required" | "rate_limited";
  retryAfter: number | null;
}

export interface EmailPageInput {
  label: string;
  accountId: string | null;
  limit?: number;
  beforeDate?: EmailSummary["date"] | null;
  beforeAccountId?: string | null;
  beforeId?: string | null;
}

export interface ContactSuggestion {
  name: string;
  email: string;
}

export interface EmailAttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string | null;
  data: string | null;
}

export interface CustomNotificationInput {
  title: string;
  body: string;
  kind: "mail" | "update";
  code?: string | null;
  emailId?: string | null;
  duration: number;
  accountId?: string | null;
  accountPicture?: string | null;
  multiAccount?: boolean;
}

export const tauriApi = {
  getAccounts: () => invoke<Account[]>("get_accounts"),
  getAccountAuth: (accountId: string) =>
    invoke<AuthInfo | null>("get_account_auth", { accountId }),
  startGoogleOAuth: () => invoke<AuthInfo>("start_google_oauth"),
  refreshAccessToken: (accountId: string) =>
    invoke<AuthInfo>("refresh_access_token", { accountId }),
  removeAccount: (accountId: string) =>
    invoke<void>("remove_account", { accountId }),
  reorderAccounts: (orderedIds: string[]) =>
    invoke<void>("reorder_accounts", { orderedIds }),
  getEmailsByLabel: (input: EmailPageInput) =>
    invoke<EmailSummary[]>("get_emails_by_label", { ...input }),
  searchLocalEmails: (query: string, accountId: string | null, limit: number) =>
    invoke<EmailSummary[]>("search_local_emails", { query, accountId, limit }),
  searchContacts: (query: string, accountId: string) =>
    invoke<ContactSuggestion[]>("search_contacts", { query, accountId }),
  getMailboxDownloadStatus: (accountId: string | null) =>
    invoke<MailboxDownloadStatus>("get_mailbox_download_status", { accountId }),
  resetLocalMailCache: (accountId: string | null) =>
    invoke<void>("reset_local_mail_cache", { accountId }),
  syncEmails: (accountId: string, accessToken: string, force: boolean) =>
    invoke<void>("sync_emails", { accountId, accessToken, force }),
  getInboxUnreadCount: (accountId: string | null) =>
    invoke<number>("get_inbox_unread_count", { accountId }),
  getEmailBody: (id: string, accountId: string) =>
    invoke<string>("get_email_body", { id, accountId }),
  getEmailAttachments: (emailId: string, accountId: string) =>
    invoke<EmailAttachmentInfo[]>("get_email_attachments", { emailId, accountId }),
  fetchAttachmentData: (emailId: string, accountId: string, attachmentDbId: string, accessToken: string) =>
    invoke<string>("fetch_attachment_data", { emailId, accountId, attachmentDbId, accessToken }),
  saveAndRevealAttachment: (emailId: string, accountId: string, attachmentDbId: string, accessToken: string) =>
    invoke<string>("save_and_reveal_attachment", { emailId, accountId, attachmentDbId, accessToken }),
  refreshEmailFromGmail: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("refresh_email_from_gmail", { accountId, accessToken, messageId }),
  getThreadEmails: (threadId: string, accountId: string) =>
    invoke<EmailSummary[]>("get_thread_emails", { threadId, accountId }),
  markAsRead: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("mark_as_read", { accountId, accessToken, messageId }),
  markAsUnread: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("mark_as_unread", { accountId, accessToken, messageId }),
  archiveEmail: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("archive_email", { accountId, accessToken, messageId }),
  trashEmail: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("trash_email", { accountId, accessToken, messageId }),
  moveToInbox: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("move_to_inbox", { accountId, accessToken, messageId }),
  permanentlyDelete: (accountId: string, accessToken: string, messageId: string) =>
    invoke<void>("permanently_delete", { accountId, accessToken, messageId }),
  sendReply: (input: {
    accountId: string;
    accessToken: string;
    to: string;
    subject: string;
    body: string;
    threadId: string;
    messageId: string;
    attachments: AttachmentPayload[] | null;
  }) => invoke<void>("send_reply", { ...input }),
  sendEmail: (input: {
    accessToken: string;
    to: string;
    subject: string;
    body: string;
    attachments: AttachmentPayload[] | null;
  }) => invoke<void>("send_email", { ...input }),
  getLaunchAtStartup: () => invoke<boolean>("get_launch_at_startup"),
  setLaunchAtStartup: (enabled: boolean) =>
    invoke<boolean>("set_launch_at_startup", { enabled }),
  getAppControls: () => invoke<AppControls>("get_app_controls"),
  setAppControls: (controls: AppControls) =>
    invoke<AppControls>("set_app_controls", { controls }),
  setAppLanguage: (language: AppControls["appLanguage"]) =>
    invoke<AppControls>("set_app_language", { language }),
  isSystemFullscreen: () => invoke<boolean>("is_system_fullscreen"),
  showCustomNotification: (notification: CustomNotificationInput) =>
    invoke<void>("show_custom_notification", { ...notification }),
};

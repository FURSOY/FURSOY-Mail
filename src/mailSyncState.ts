import type { EmailSummary } from "./types";

export function emailCacheKey(email: Pick<EmailSummary, "account_id" | "id">): string {
  return `${email.account_id}\u0000${email.id}`;
}

interface UpdateNotificationBaselineOptions {
  freshInbox: EmailSummary[];
  knownEmailIds: Set<string>;
  readyAccountIds: Set<string>;
  successfullySyncedAccountIds: Set<string>;
  suppressNotifications: boolean;
}

export function updateNotificationBaseline(options: UpdateNotificationBaselineOptions): EmailSummary[] {
  const {
    freshInbox, knownEmailIds, readyAccountIds,
    successfullySyncedAccountIds, suppressNotifications,
  } = options;
  const newUnreadEmails = freshInbox.filter(email =>
    !suppressNotifications && email.unread && readyAccountIds.has(email.account_id) &&
    !knownEmailIds.has(emailCacheKey(email))
  );

  for (const email of freshInbox) knownEmailIds.add(emailCacheKey(email));
  for (const accountId of successfullySyncedAccountIds) readyAccountIds.add(accountId);
  return newUnreadEmails;
}

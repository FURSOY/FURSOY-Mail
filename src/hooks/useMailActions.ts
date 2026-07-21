import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AppLocale } from "../i18n";
import type { Account, AttachmentPayload, EmailSummary } from "../types";
import { tauriApi } from "../tauriApi";
import { inboxUnreadDelta, runAuthenticatedMailAction } from "../mailActionState";
import { escapeHtml, formatDateFull, isAuthFailure, sanitizeComposerHtml } from "../utils";

export interface ConfirmModalState {
  message: string;
  onConfirm: () => void;
}

interface UseMailActionsOptions {
  locale: AppLocale;
  accounts: Account[];
  accountTokens: Record<string, string>;
  activeAccountId: string | null;
  activeMail: EmailSummary | undefined;
  selectedMailBody: string;
  activeTabRef: MutableRefObject<string>;
  recentlyReadRef: MutableRefObject<Set<string>>;
  setEmails: Dispatch<SetStateAction<EmailSummary[]>>;
  setSelectedMail: Dispatch<SetStateAction<string | null>>;
  setThreadRefreshKey: Dispatch<SetStateAction<number>>;
  getTokenForEmail: (email: EmailSummary | undefined) => string;
  loadEmails: (tab?: string) => Promise<EmailSummary[]>;
  refreshUnreadCount: () => Promise<number>;
  adjustUnreadBadge: (accountId: string, delta: number) => void;
  refreshAccessToken: (accountId: string) => Promise<{ authenticated: boolean }>;
  upsertToken: (accountId: string, accessToken: string) => void;
  clearExpiredAccount: (accountId: string) => void;
  markAccountExpired: (accountId: string, showMessage?: boolean) => void;
  showToast: (message: string, type?: "error" | "success" | "info") => void;
}

function sameEmail(left: EmailSummary, right: EmailSummary) {
  return left.id === right.id && left.account_id === right.account_id;
}

function emailKey(email: EmailSummary) {
  return `${email.account_id}\u0000${email.id}`;
}

function actionFailureMessage(summary: string, error: unknown) {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/^Error:\s*/i, "")
    .trim();
  return detail ? `${summary}: ${detail.slice(0, 180)}` : summary;
}

const SENT_VERIFICATION_DELAYS_MS = [0, 1_500, 3_000, 6_000, 10_000];

async function verifyUncertainSend(accountId: string, messageId: string) {
  for (const delay of SENT_VERIFICATION_DELAYS_MS) {
    if (delay > 0) {
      await new Promise(resolve => window.setTimeout(resolve, delay));
    }
    try {
      if (await tauriApi.verifySentMessage(accountId, messageId)) return true;
    } catch {
      // A verification request may fail transiently. Keep the send locked and
      // exhaust the bounded checks; never turn this into an automatic resend.
    }
  }
  return false;
}

export function useMailActions(options: UseMailActionsOptions) {
  const {
    locale, accounts, accountTokens, activeAccountId, activeMail, selectedMailBody,
    activeTabRef, recentlyReadRef, setEmails, setSelectedMail,
    setThreadRefreshKey, getTokenForEmail, loadEmails, refreshUnreadCount,
    adjustUnreadBadge, refreshAccessToken, upsertToken, clearExpiredAccount,
    markAccountExpired, showToast,
  } = options;

  const [showReply, setShowReply] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all">("reply");
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeHtmlAppend, setComposeHtmlAppend] = useState("");
  const [composeAccountId, setComposeAccountId] = useState<string | null>(null);
  const [composeSendError, setComposeSendError] = useState<string | null>(null);

  const runAuthenticatedAction = useCallback(async (
    mail: EmailSummary,
    action: (accessToken: string) => Promise<void>,
  ) => {
    const currentToken = getTokenForEmail(mail);
    await runAuthenticatedMailAction({
      accountId: mail.account_id,
      currentToken,
      reloginRequiredMessage: locale.messages.reloginRequired,
      action,
      refreshAccessToken,
      upsertToken,
      clearExpiredAccount,
      markAccountExpired,
    });
  }, [
    clearExpiredAccount, getTokenForEmail, locale, markAccountExpired,
    refreshAccessToken, upsertToken,
  ]);

  const handleArchive = useCallback(async (mail: EmailSummary) => {
    if (!getTokenForEmail(mail)) return;
    const unreadDelta = inboxUnreadDelta(mail, "archive");
    if (unreadDelta) adjustUnreadBadge(mail.account_id, unreadDelta);
    setEmails(previous => previous.map(email => sameEmail(email, mail) ? { ...email, label: "archive" } : email));
    setSelectedMail(null);
    try {
      await runAuthenticatedAction(mail, () => tauriApi.archiveEmail(mail.account_id, mail.id));
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch (error) {
      if (unreadDelta) adjustUnreadBadge(mail.account_id, -unreadDelta);
      console.error("Archive email failed:", error);
      showToast(actionFailureMessage(locale.messages.archiveFailed, error), "error");
      void loadEmails(activeTabRef.current);
    }
  }, [activeTabRef, adjustUnreadBadge, getTokenForEmail, loadEmails, locale, refreshUnreadCount, runAuthenticatedAction, setEmails, setSelectedMail, showToast]);

  const handleTrash = useCallback(async (mail: EmailSummary) => {
    if (!getTokenForEmail(mail)) return;
    const unreadDelta = inboxUnreadDelta(mail, "trash");
    if (unreadDelta) adjustUnreadBadge(mail.account_id, unreadDelta);
    setEmails(previous => previous.map(email => sameEmail(email, mail) ? { ...email, label: "trash" } : email));
    setSelectedMail(null);
    try {
      await runAuthenticatedAction(mail, () => tauriApi.trashEmail(mail.account_id, mail.id));
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch (error) {
      if (unreadDelta) adjustUnreadBadge(mail.account_id, -unreadDelta);
      console.error("Trash email failed:", error);
      showToast(actionFailureMessage(locale.messages.deleteFailed, error), "error");
      void loadEmails(activeTabRef.current);
    }
  }, [activeTabRef, adjustUnreadBadge, getTokenForEmail, loadEmails, locale, refreshUnreadCount, runAuthenticatedAction, setEmails, setSelectedMail, showToast]);

  const handleMoveToInbox = useCallback(async (mail: EmailSummary) => {
    if (!getTokenForEmail(mail)) return;
    const unreadDelta = inboxUnreadDelta(mail, "inbox");
    if (unreadDelta) adjustUnreadBadge(mail.account_id, unreadDelta);
    setEmails(previous => previous.filter(email => !sameEmail(email, mail)));
    setSelectedMail(null);
    try {
      await runAuthenticatedAction(mail, () => tauriApi.moveToInbox(mail.account_id, mail.id));
      showToast(locale.messages.movedToInbox, "success");
      void loadEmails(activeTabRef.current);
      void refreshUnreadCount();
    } catch (error) {
      if (unreadDelta) adjustUnreadBadge(mail.account_id, -unreadDelta);
      console.error("Move email to inbox failed:", error);
      showToast(actionFailureMessage(locale.messages.moveFailed, error), "error");
      void loadEmails(activeTabRef.current);
    }
  }, [activeTabRef, adjustUnreadBadge, getTokenForEmail, loadEmails, locale, refreshUnreadCount, runAuthenticatedAction, setEmails, setSelectedMail, showToast]);

  const handlePermanentDelete = useCallback((mail: EmailSummary) => {
    if (!getTokenForEmail(mail)) return;
    setConfirmModal({
      message: locale.messages.permanentDeleteConfirm,
      onConfirm: async () => {
        setEmails(previous => previous.filter(email => !sameEmail(email, mail)));
        setSelectedMail(null);
        try {
          await runAuthenticatedAction(mail, () => tauriApi.permanentlyDelete(mail.account_id, mail.id));
          showToast(locale.messages.permanentlyDeleted, "success");
        } catch (error) {
          console.error("Permanently delete email failed:", error);
          showToast(actionFailureMessage(locale.messages.deleteFailed, error), "error");
          void loadEmails(activeTabRef.current);
        }
      },
    });
  }, [activeTabRef, getTokenForEmail, loadEmails, locale, runAuthenticatedAction, setEmails, setSelectedMail, showToast]);

  const handleReply = useCallback(async (attachments: AttachmentPayload[] = [], body = "") => {
    if (!activeMail || (!body.trim() && attachments.length === 0)) return;
    const accessToken = getTokenForEmail(activeMail);
    if (!accessToken) return;
    setIsSending(true);
    try {
      const extractAddress = (raw: string) => raw.match(/<([^>]+)>/)?.[1].trim() ?? raw.trim();
      const senderAddress = extractAddress(activeMail.sender);
      let to: string;
      if (replyMode === "reply-all") {
        const ownAddress = activeMail.account_id ?? "";
        const recipients = activeMail.recipient.split(",")
          .map(value => extractAddress(value.trim()))
          .filter(value => value && value.toLowerCase() !== ownAddress.toLowerCase());
        const ccRecipients = activeMail.cc.split(",")
          .map(value => extractAddress(value.trim()))
          .filter(value => value && value.toLowerCase() !== ownAddress.toLowerCase());
        to = [senderAddress, ...recipients, ...ccRecipients].join(", ");
      } else {
        to = senderAddress;
      }
      const quoteHeading = locale.compose.wroteOn
        .replace("{date}", escapeHtml(formatDateFull(activeMail.date)))
        .replace("{sender}", `<b>${escapeHtml(activeMail.sender)}</b>`);
      const quotedBody = sanitizeComposerHtml(selectedMailBody || activeMail.snippet);
      const quotedHtml = `<br/><br/><blockquote><div>${quoteHeading}</div>${quotedBody}</blockquote>`;
      const outcome = await tauriApi.sendReply({
        accountId: activeMail.account_id,
        to,
        subject: activeMail.subject,
        body: body + quotedHtml,
        threadId: activeMail.thread_id || activeMail.id,
        messageId: activeMail.id,
        attachments: attachments.length > 0 ? attachments : null,
      });
      if (outcome.status === "outcome_unknown") {
        showToast(locale.messages.sendOutcomeUnknown, "info");
        const verified = await verifyUncertainSend(activeMail.account_id, outcome.messageId);
        if (!verified) {
          showToast(locale.messages.sendOutcomeUnresolved, "error");
          return;
        }
        showToast(locale.messages.sendOutcomeVerified, "success");
      }
      setReplyText("");
      setShowReply(false);
      setThreadRefreshKey(current => current + 1);
    } catch {
      showToast(locale.messages.replySendFailed, "error");
    } finally {
      setIsSending(false);
    }
  }, [activeMail, getTokenForEmail, locale, replyMode, selectedMailBody, setThreadRefreshKey, showToast]);

  const handleComposeSend = useCallback(async (
    attachments: AttachmentPayload[],
    body: string,
    draftId: string | null,
    verificationMessageId: string | null,
  ): Promise<boolean> => {
    if (!composeTo.trim() || !composeSubject.trim()) return false;
    const sendFromId = composeAccountId ?? activeAccountId ?? accounts[0]?.id;
    if (!sendFromId) {
      setComposeSendError(locale.messages.noSendAccount);
      return false;
    }
    setComposeSendError(null);
    setIsSending(true);
    let token = accountTokens[sendFromId];
    if (!token) {
      try {
        const refreshed = await refreshAccessToken(sendFromId);
        if (!refreshed.authenticated) throw new Error(locale.messages.reloginRequired);
        token = "active";
        upsertToken(sendFromId, token);
        clearExpiredAccount(sendFromId);
      } catch {
        setComposeSendError(locale.messages.reloginRequired);
        setIsSending(false);
        return false;
      }
    }
    try {
      const outcome = draftId && verificationMessageId
        ? await tauriApi.sendDraft(sendFromId, draftId, verificationMessageId)
        : await tauriApi.sendEmail({
            accountId: sendFromId,
            to: composeTo,
            subject: composeSubject,
            body: body + composeHtmlAppend,
            attachments: attachments.length > 0 ? attachments : null,
          });
      if (outcome.status === "outcome_unknown") {
        setComposeSendError(locale.messages.sendOutcomeUnknown);
        showToast(locale.messages.sendOutcomeUnknown, "info");
        const verified = await verifyUncertainSend(sendFromId, outcome.messageId);
        if (!verified) {
          setComposeSendError(locale.messages.sendOutcomeUnresolved);
          showToast(locale.messages.sendOutcomeUnresolved, "error");
          return false;
        }
      }
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      setComposeHtmlAppend("");
      setComposeSendError(null);
      showToast(
        outcome.status === "outcome_unknown"
          ? locale.messages.sendOutcomeVerified
          : locale.messages.emailSent,
        "success",
      );
      return true;
    } catch (error) {
      const raw = String(error);
      if (isAuthFailure(raw)) {
        markAccountExpired(sendFromId);
        setComposeSendError(locale.messages.reloginRequired);
      } else {
        const message = raw.replace(/^Error:\s*/i, "").replace(/Gmail send error:\s*/i, "");
        setComposeSendError(message || locale.messages.sendFailed);
      }
      return false;
    } finally {
      setIsSending(false);
    }
  }, [
    accountTokens, accounts, activeAccountId, clearExpiredAccount, composeAccountId,
    composeHtmlAppend, composeSubject, composeTo, locale, markAccountExpired,
    refreshAccessToken, showToast, upsertToken,
  ]);

  const handleMarkAsUnread = useCallback(async (mail: EmailSummary) => {
    if (!getTokenForEmail(mail)) return;
    recentlyReadRef.current.delete(emailKey(mail));
    setEmails(previous => previous.map(email => sameEmail(email, mail) ? { ...email, unread: true } : email));
    adjustUnreadBadge(mail.account_id, 1);
    try {
      await runAuthenticatedAction(mail, () => tauriApi.markAsUnread(mail.account_id, mail.id));
    } catch (error) {
      console.error("Mark email as unread failed:", error);
      adjustUnreadBadge(mail.account_id, -1);
      showToast(actionFailureMessage(locale.messages.operationFailed, error), "error");
      void loadEmails(activeTabRef.current);
    }
  }, [activeTabRef, adjustUnreadBadge, getTokenForEmail, loadEmails, locale, recentlyReadRef, runAuthenticatedAction, setEmails, showToast]);

  const handleForward = useCallback((mail: EmailSummary) => {
    const header = `<br/><br/><div><b>---------- ${escapeHtml(locale.compose.forwardedMessage)} ----------</b><br/>${escapeHtml(locale.compose.senderLabel)}: ${escapeHtml(mail.sender)}<br/>${escapeHtml(locale.compose.subject)}: ${escapeHtml(mail.subject)}<br/>${escapeHtml(locale.compose.dateLabel)}: ${escapeHtml(formatDateFull(mail.date))}<br/><br/></div>`;
    const forwardedBody = sanitizeComposerHtml(selectedMailBody || mail.snippet);
    setComposeTo("");
    setComposeSubject(`Fwd: ${mail.subject.replace(/^(Fwd:\s*)+/i, "")}`);
    setComposeBody("");
    setComposeHtmlAppend(header + forwardedBody);
    setComposeAccountId(mail.account_id ?? activeAccountId ?? accounts[0]?.id ?? null);
    setShowCompose(true);
  }, [accounts, activeAccountId, locale, selectedMailBody]);

  return {
    showReply, setShowReply, replyMode, setReplyMode, replyText, setReplyText,
    isSending, showCompose, setShowCompose, confirmModal, setConfirmModal,
    composeTo, setComposeTo, composeSubject, setComposeSubject, composeBody, setComposeBody,
    composeHtmlAppend, setComposeHtmlAppend, composeAccountId, setComposeAccountId,
    composeSendError, setComposeSendError,
    handleArchive, handleTrash, handleMoveToInbox, handlePermanentDelete,
    handleReply, handleComposeSend, handleMarkAsUnread, handleForward,
  };
}

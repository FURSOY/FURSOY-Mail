import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AppLocale } from "../i18n";
import type { Account, AttachmentPayload, EmailSummary } from "../types";
import { tauriApi } from "../tauriApi";
import { inboxUnreadDelta, runAuthenticatedMailAction } from "../mailActionState";
import { formatDateFull, isAuthFailure } from "../utils";

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
  refreshAccessToken: (accountId: string) => Promise<{ access_token: string }>;
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
      await runAuthenticatedAction(mail, token => tauriApi.archiveEmail(mail.account_id, token, mail.id));
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
      await runAuthenticatedAction(mail, token => tauriApi.trashEmail(mail.account_id, token, mail.id));
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
      await runAuthenticatedAction(mail, token => tauriApi.moveToInbox(mail.account_id, token, mail.id));
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
          await runAuthenticatedAction(mail, token => tauriApi.permanentlyDelete(mail.account_id, token, mail.id));
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
        .replace("{date}", formatDateFull(activeMail.date))
        .replace("{sender}", `<b>${activeMail.sender}</b>`);
      const quotedHtml = `<br/><br/><div style="border-left:3px solid #ccc;padding-left:12px;color:#888;margin-top:8px"><div style="margin-bottom:6px;font-size:12px">${quoteHeading}</div>${selectedMailBody || activeMail.snippet}</div>`;
      await tauriApi.sendReply({
        accountId: activeMail.account_id,
        accessToken,
        to,
        subject: activeMail.subject,
        body: body + quotedHtml,
        threadId: activeMail.thread_id || activeMail.id,
        messageId: activeMail.id,
        attachments: attachments.length > 0 ? attachments : null,
      });
      setReplyText("");
      setShowReply(false);
      setThreadRefreshKey(current => current + 1);
    } catch {
      showToast(locale.messages.replySendFailed, "error");
    } finally {
      setIsSending(false);
    }
  }, [activeMail, getTokenForEmail, locale, replyMode, selectedMailBody, setThreadRefreshKey, showToast]);

  const handleComposeSend = useCallback(async (attachments: AttachmentPayload[], body: string) => {
    if (!composeTo.trim() || !composeSubject.trim()) return;
    const sendFromId = composeAccountId ?? activeAccountId ?? accounts[0]?.id;
    if (!sendFromId) {
      setComposeSendError(locale.messages.noSendAccount);
      return;
    }
    setComposeSendError(null);
    setIsSending(true);
    let token = accountTokens[sendFromId];
    if (!token) {
      try {
        const refreshed = await refreshAccessToken(sendFromId);
        token = refreshed.access_token;
        upsertToken(sendFromId, token);
        clearExpiredAccount(sendFromId);
      } catch {
        setComposeSendError(locale.messages.reloginRequired);
        setIsSending(false);
        return;
      }
    }
    try {
      await tauriApi.sendEmail({
        accessToken: token,
        to: composeTo,
        subject: composeSubject,
        body: body + composeHtmlAppend,
        attachments: attachments.length > 0 ? attachments : null,
      });
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      setComposeHtmlAppend("");
      setComposeSendError(null);
      showToast(locale.messages.emailSent, "success");
    } catch (error) {
      const raw = String(error);
      if (isAuthFailure(raw)) {
        markAccountExpired(sendFromId);
        setComposeSendError(locale.messages.reloginRequired);
      } else {
        const message = raw.replace(/^Error:\s*/i, "").replace(/Gmail send error:\s*/i, "");
        setComposeSendError(message || locale.messages.sendFailed);
      }
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
      await runAuthenticatedAction(mail, token => tauriApi.markAsUnread(mail.account_id, token, mail.id));
    } catch (error) {
      console.error("Mark email as unread failed:", error);
      adjustUnreadBadge(mail.account_id, -1);
      showToast(actionFailureMessage(locale.messages.operationFailed, error), "error");
      void loadEmails(activeTabRef.current);
    }
  }, [activeTabRef, adjustUnreadBadge, getTokenForEmail, loadEmails, locale, recentlyReadRef, runAuthenticatedAction, setEmails, showToast]);

  const handleForward = useCallback((mail: EmailSummary) => {
    const header = `<br/><br/><div style="border-top:1px solid #eee;padding-top:12px;color:#555;font-size:13px"><b>---------- ${locale.compose.forwardedMessage} ----------</b><br/>${locale.compose.senderLabel}: ${mail.sender}<br/>${locale.compose.subject}: ${mail.subject}<br/>${locale.compose.dateLabel}: ${formatDateFull(mail.date)}<br/><br/></div>`;
    setComposeTo("");
    setComposeSubject(`Fwd: ${mail.subject.replace(/^(Fwd:\s*)+/i, "")}`);
    setComposeBody("");
    setComposeHtmlAppend(header + (selectedMailBody || mail.snippet));
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

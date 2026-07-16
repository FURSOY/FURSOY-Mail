import { useEffect, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { AppLocale } from "../i18n";
import type { EmailSummary } from "../types";
import { tauriApi } from "../tauriApi";

interface UseMailReaderOptions {
  selectedMail: string | null;
  activeMail: EmailSummary | undefined;
  activeMailKey: string | null;
  locale: AppLocale;
  mailScrollRef: RefObject<HTMLDivElement | null>;
  recentlyReadRef: MutableRefObject<Set<string>>;
  setEmails: Dispatch<SetStateAction<EmailSummary[]>>;
  setSearchResults: Dispatch<SetStateAction<EmailSummary[] | null>>;
  setReadingToolsOpen: Dispatch<SetStateAction<boolean>>;
  getTokenForEmail: (email: EmailSummary | undefined) => string;
  adjustUnreadBadge: (accountId: string, delta: number) => void;
}

function sameEmail(left: EmailSummary, right: EmailSummary) {
  return left.id === right.id && left.account_id === right.account_id;
}

function emailKey(email: EmailSummary) {
  return `${email.account_id}\u0000${email.id}`;
}

export function useMailReader(options: UseMailReaderOptions) {
  const {
    selectedMail, activeMail, activeMailKey, locale, mailScrollRef, recentlyReadRef,
    setEmails, setSearchResults, setReadingToolsOpen, getTokenForEmail, adjustUnreadBadge,
  } = options;
  const [selectedMailBody, setSelectedMailBody] = useState("");
  const [selectedMailBodyId, setSelectedMailBodyId] = useState<string | null>(null);
  const [isBodyLoading, setIsBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [threadEmails, setThreadEmails] = useState<EmailSummary[]>([]);
  const [threadRefreshKey, setThreadRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSelectedMailBody("");
    setSelectedMailBodyId(null);
    setBodyError(null);
    setIsBodyLoading(false);
    setReadingToolsOpen(false);
    if (mailScrollRef.current) mailScrollRef.current.scrollTop = 0;
    if (!selectedMail || !activeMail) return;
    setIsBodyLoading(true);
    tauriApi.getEmailBody(activeMail.id, activeMail.account_id)
      .then(body => {
        if (cancelled) return;
        setSelectedMailBody(body || "");
        setSelectedMailBodyId(selectedMail);
      })
      .catch(error => {
        if (cancelled) return;
        console.error("Failed to load email body:", error);
        setBodyError(locale.mail.bodyLoadFailed);
      })
      .finally(() => { if (!cancelled) setIsBodyLoading(false); });
    return () => { cancelled = true; };
  }, [selectedMail, activeMailKey]);

  useEffect(() => {
    if (!activeMail || !activeMailKey) return;
    const token = getTokenForEmail(activeMail);
    if (!token) return;
    let cancelled = false;
    void tauriApi.refreshEmailFromGmail(activeMail.account_id, token, activeMail.id)
      .then(() => tauriApi.getEmailBody(activeMail.id, activeMail.account_id))
      .then(body => {
        if (cancelled || selectedMail !== activeMailKey) return;
        setSelectedMailBody(body || "");
        setSelectedMailBodyId(activeMailKey);
      })
      .catch(() => {
        // The locally cached message remains usable when this refresh fails.
      });
    return () => { cancelled = true; };
  }, [activeMailKey]);

  const selectedMailThreadId = activeMail?.thread_id;
  useEffect(() => {
    if (!selectedMail || !selectedMailThreadId || !activeMail) {
      setThreadEmails([]);
      return;
    }
    let cancelled = false;
    tauriApi.getThreadEmails(selectedMailThreadId, activeMail.account_id)
      .then(all => {
        if (cancelled) return;
        setThreadEmails(all);
        for (const email of all) {
          if (!email.unread || recentlyReadRef.current.has(emailKey(email))) continue;
          recentlyReadRef.current.add(emailKey(email));
          setEmails(previous => previous.map(item => sameEmail(item, email) ? { ...item, unread: false } : item));
          setSearchResults(previous => previous?.map(item => sameEmail(item, email) ? { ...item, unread: false } : item) ?? null);
          adjustUnreadBadge(email.account_id, -1);
          const token = getTokenForEmail(email);
          if (!token) continue;
          tauriApi.markAsRead(email.account_id, token, email.id).catch(error => {
            console.error("Failed to mark thread email as read:", error);
            recentlyReadRef.current.delete(emailKey(email));
            setEmails(previous => previous.map(item => sameEmail(item, email) ? { ...item, unread: true } : item));
            setSearchResults(previous => previous?.map(item => sameEmail(item, email) ? { ...item, unread: true } : item) ?? null);
            setThreadEmails(previous => previous.map(item => sameEmail(item, email) ? { ...item, unread: true } : item));
            adjustUnreadBadge(email.account_id, 1);
          });
        }
      })
      .catch(() => { if (!cancelled) setThreadEmails([]); });
    return () => { cancelled = true; };
  }, [selectedMail, selectedMailThreadId, threadRefreshKey]);

  return {
    selectedMailBody,
    setSelectedMailBody,
    selectedMailBodyId,
    setSelectedMailBodyId,
    isBodyLoading,
    bodyError,
    threadEmails,
    setThreadEmails,
    setThreadRefreshKey,
  };
}

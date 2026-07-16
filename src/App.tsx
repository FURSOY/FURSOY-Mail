import { useState, useEffect, useRef, useCallback, useTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Minus, Square, Copy, X, Edit3, Menu, Inbox, AlertTriangle, CheckCircle, XCircle,
} from "lucide-react";
import { LocaleContext, locales, type AppLanguage } from "./i18n";
import { themePresets, type ThemePresetName } from "./theme";
import "./index.css";

import {
  type Account, type EmailSummary, type ThreadGroup, type AuthInfo, type AppControls, type OtpMode, type RenderMode,
  type MailZoom, type DensityMode, type MailViewMode, type MailViewPreference,
  type RemoteImageMode, DEFAULT_APP_CONTROLS,
} from "./types";
import { useMemo } from "react";
import {
  MAIL_TABS, AUTH_RELOGIN_MESSAGE, STARTUP_NETWORK_DELAY_MS, STARTUP_UPDATE_DELAY_MS,
  MAX_LABEL_CACHE, MAIL_PAGE_SIZE, ZOOM_STEPS,
  isNoUpdateError, isAuthFailure, extractVerificationCode,
  readMailZoom, readThemePreset, getAutoMailViewMode,
  isInQuietHours, formatDateFull,
} from "./utils";

import { Sidebar } from "./components/Sidebar";
import { Onboarding } from "./components/Onboarding";
import { EmailList } from "./components/EmailList";
import { EmailReader } from "./components/EmailReader";
import { SettingsPanel } from "./components/SettingsPanel";
import { ComposeModal } from "./components/ComposeModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { ToolbarTip } from "./components/ToolbarTip";

function readTrustedImageSenders(): Record<string, string[]> {
  try {
    const saved = JSON.parse(localStorage.getItem("fursoy_trusted_image_senders") ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(
      Object.entries(saved).filter(([, senders]) =>
        Array.isArray(senders) && senders.every(sender => typeof sender === "string")
      )
    ) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function getSenderAddress(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return (match?.[1] ?? sender).trim().toLowerCase();
}

function mailKey(accountId: string, messageId: string): string {
  return `${accountId}\u0000${messageId}`;
}

function emailKey(email: EmailSummary): string {
  return mailKey(email.account_id, email.id);
}

function sameEmail(left: EmailSummary, right: EmailSummary): boolean {
  return left.id === right.id && left.account_id === right.account_id;
}

interface MailboxDownloadStatus {
  running: boolean;
  pending: boolean;
  state: "waiting" | "running" | "paused" | "error" | "completed" | "relogin_required" | "rate_limited";
  retryAfter: number | null;
}

function App() {
  const [activeTab, setActiveTab] = useState<"inbox" | "sent" | "archive" | "spam" | "trash" | "settings">("inbox");
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("Not authenticated");
  const [isUserSyncing, setIsUserSyncing] = useState(false);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);

  // Settings
  const [syncIntervalValue, setSyncIntervalValue] = useState(() => {
    const saved = localStorage.getItem("fursoy_sync_interval");
    return saved ? parseInt(saved, 10) : 2;
  });
  const [notifDuration, setNotifDuration] = useState(() => {
    const saved = localStorage.getItem("fursoy_notif_duration");
    return saved ? parseInt(saved, 10) : 5;
  });
  const [notifInfinite, setNotifInfinite] = useState(() => {
    return localStorage.getItem("fursoy_notif_infinite") === "true";
  });
  const [pauseOnFullscreen, setPauseOnFullscreen] = useState(() => {
    return localStorage.getItem("fursoy_pause_on_fullscreen") !== "false";
  });
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startupSettingLoading, setStartupSettingLoading] = useState(false);
  const [lazyBodyLoading, setLazyBodyLoading] = useState(() => {
    return localStorage.getItem("fursoy_lazy_body_loading") !== "false";
  });
  const [renderMode, setRenderMode] = useState<RenderMode>(() => {
    return localStorage.getItem("fursoy_render_mode") === "simple" ? "simple" : "full";
  });
  const [remoteImageMode, setRemoteImageMode] = useState<RemoteImageMode>(() => {
    const saved = localStorage.getItem("fursoy_remote_image_mode");
    return saved === "trusted" || saved === "ask" ? saved : "always";
  });
  const [trustedImageSenders, setTrustedImageSenders] = useState<Record<string, string[]>>(readTrustedImageSenders);
  const [loadedRemoteImageEmails, setLoadedRemoteImageEmails] = useState<Set<string>>(() => new Set());
  const [mailZoom, setMailZoom] = useState<MailZoom>(() => readMailZoom());
  const [mailFitScale, setMailFitScale] = useState(1);
  const [appControls, setAppControls] = useState<AppControls>(DEFAULT_APP_CONTROLS);
  const [otpMode, setOtpMode] = useState<OtpMode>(() => {
    const saved = localStorage.getItem("fursoy_otp_mode");
    return saved === "off" || saved === "strict" ? saved : "balanced";
  });
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(() => {
    const saved = localStorage.getItem("fursoy_app_language");
    return saved === "tr" ? "tr" : "en";
  });
  const tr = locales[appLanguage];
  const [themePreset, setThemePreset] = useState<ThemePresetName>(() => readThemePreset());
  const [densityMode, setDensityMode] = useState<DensityMode>(() => {
    return localStorage.getItem("fursoy_density_mode") === "compact" ? "compact" : "comfortable";
  });
  const [mailViewPreference, setMailViewPreference] = useState<MailViewPreference>(() => {
    const saved = localStorage.getItem("fursoy_mail_view_mode");
    return saved === "split" || saved === "single-toggle" || saved === "inbox-first" ? saved : "auto";
  });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [singlePanelView, setSinglePanelView] = useState<"list" | "reader">("list");
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [selectedMailBody, setSelectedMailBody] = useState("");
  const [selectedMailBodyId, setSelectedMailBodyId] = useState<string | null>(null);
  const [isBodyLoading, setIsBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [threadEmails, setThreadEmails] = useState<EmailSummary[]>([]);
  const [threadRefreshKey, setThreadRefreshKey] = useState(0);
  // multi-account
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [accountTokens, setAccountTokens] = useState<Record<string, string>>({});
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<EmailSummary[] | null>(null);
  const [hasMoreEmails, setHasMoreEmails] = useState(true);
  const [isLoadingMoreEmails, setIsLoadingMoreEmails] = useState(false);
  const [mailAppendVersion, setMailAppendVersion] = useState(0);
  const [notificationFocusVersion, setNotificationFocusVersion] = useState(0);
  const [isMailboxBackfilling, setIsMailboxBackfilling] = useState(false);
  const [mailboxDownloadPending, setMailboxDownloadPending] = useState(false);
  const [mailboxDownloadState, setMailboxDownloadState] = useState<MailboxDownloadStatus["state"]>("completed");
  const [isResettingLocalMailbox, setIsResettingLocalMailbox] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all">("reply");
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [readingToolsOpen, setReadingToolsOpen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeHtmlAppend, setComposeHtmlAppend] = useState("");
  const [composeAccountId, setComposeAccountId] = useState<string | null>(null);
  const [composeSendError, setComposeSendError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: "error" | "success" | "info" }[]>([]);
  const [verificationCopyState, setVerificationCopyState] = useState<"idle" | "copied">("idle");
  const [inboxUnread, setInboxUnread] = useState(0);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [expiredAccountIds, setExpiredAccountIds] = useState<Set<string>>(new Set());

  // Updater
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string; date: string; body: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string>("");

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mailScrollRef = useRef<HTMLDivElement>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const syncChainIdRef = useRef(0);
  const recentNotificationsRef = useRef<Record<string, { accountId: string; messageId: string } | null>>({});
  const notifiedUpdateVersionRef = useRef<string | null>(null);
  const lastToastRef = useRef<{ msg: string; type: "error" | "success" | "info"; at: number } | null>(null);
  const previousAutoMailViewModeRef = useRef<MailViewMode | null>(null);
  const tokenExpiredRef = useRef(tokenExpired);
  // multi-account refs
  const accountTokensRef = useRef<Record<string, string>>({});
  const accountsRef = useRef<Account[]>([]);
  const activeAccountIdRef = useRef<string | null>(null);
  const expiredAccountsRef = useRef<Set<string>>(new Set());
  const backgroundSyncRef = useRef<
    (opts?: { userInitiated?: boolean; suppressNotifications?: boolean }) => Promise<boolean>
  >(async () => false);
  const knownEmailIdsRef = useRef<Set<string>>(new Set());
  const notificationReadyAccountIdsRef = useRef<Set<string>>(new Set());
  const notificationBaselineEpochRef = useRef(0);
  const recentlyReadRef = useRef<Set<string>>(new Set());
  const pendingUnreadBadgeDeltasRef = useRef<Map<string, { delta: number; expiresAt: number }>>(new Map());
  const mailPageCursorRef = useRef<EmailSummary | null>(null);
  const mailListRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const isLoadingMoreEmailsRef = useRef(false);
  const tabEmailCacheRef = useRef<Partial<Record<string, EmailSummary[]>>>({});
  const [, startTabTransition] = useTransition();
  const [, startDataTransition] = useTransition();
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const syncIntervalValueRef = useRef(syncIntervalValue);
  syncIntervalValueRef.current = syncIntervalValue;
  const notifDurationRef = useRef(notifDuration);
  notifDurationRef.current = notifDuration;
  const notifInfiniteRef = useRef(notifInfinite);
  notifInfiniteRef.current = notifInfinite;
  const pauseOnFullscreenRef = useRef(pauseOnFullscreen);
  pauseOnFullscreenRef.current = pauseOnFullscreen;
  const appControlsRef = useRef(appControls);
  appControlsRef.current = appControls;
  tokenExpiredRef.current = tokenExpired;

  // Keep refs in sync
  useEffect(() => { accountTokensRef.current = accountTokens; }, [accountTokens]);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);
  useEffect(() => { activeAccountIdRef.current = activeAccountId; }, [activeAccountId]);

  // Derive a "current context" access token (for UI checks and email-less operations)
  const accessToken = (() => {
    if (activeAccountId && accountTokens[activeAccountId]) return accountTokens[activeAccountId];
    const primary = accounts[0];
    if (primary && accountTokens[primary.id]) return accountTokens[primary.id];
    return null;
  })();

  // Look up the right token for a specific email's account
  const getTokenForEmail = (email: EmailSummary | undefined): string => {
    return email ? accountTokens[email.account_id] ?? "" : "";
  };

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        const maximized = await win.isMaximized();
        if (!disposed) setIsWindowMaximized(maximized);
      } catch (err) {
        console.error("Failed to read window maximized state:", err);
      }
    };

    void syncMaximizedState();
    win.onResized(() => { void syncMaximizedState(); })
      .then((unlisten) => { if (disposed) unlisten(); else unlistenResize = unlisten; })
      .catch((err) => { console.error("Failed to listen for window resize:", err); });

    return () => { disposed = true; unlistenResize?.(); };
  }, []);

  useEffect(() => {
    const preset = themePresets[themePreset];
    const root = document.documentElement;
    root.style.setProperty("--app-accent", preset.accent);
    root.style.setProperty("--app-accent-hover", preset.accentHover);
    root.style.setProperty("--app-accent-soft", preset.accentSoft);
    root.dataset.density = densityMode;
  }, [themePreset, densityMode]);

  useEffect(() => {
    localStorage.setItem("fursoy_app_language", appLanguage);
  }, [appLanguage]);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(console.error);
    invoke<boolean>("get_launch_at_startup").then(setLaunchAtStartup).catch(console.error);
    invoke<AppControls>("get_app_controls")
      .then((controls) => {
        const localLanguage = localStorage.getItem("fursoy_app_language") === "tr" ? "tr" : "en";
        const savedLanguage: AppLanguage = controls.appLanguage === "en" || controls.appLanguage === "tr"
          ? controls.appLanguage
          : localLanguage;
        const normalized: AppControls = { ...DEFAULT_APP_CONTROLS, ...controls, appLanguage: savedLanguage };
        setAppControls(normalized);
        setAppLanguage(savedLanguage);
        localStorage.setItem("fursoy_app_language", savedLanguage);
        if (controls.appLanguage !== savedLanguage) {
          void invoke("set_app_language", { language: savedLanguage });
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<AppControls>("app-controls-changed", (event) => {
      const savedLanguage: AppLanguage = event.payload.appLanguage === "tr" ? "tr" : "en";
      const normalized: AppControls = { ...DEFAULT_APP_CONTROLS, ...event.payload, appLanguage: savedLanguage };
      setAppControls(normalized);
      setAppLanguage(savedLanguage);
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  const showToast = useCallback((msg: string, type: "error" | "success" | "info" = "info") => {
    const id = Date.now();
    const lastToast = lastToastRef.current;
    if (lastToast?.msg === msg && lastToast.type === type && id - lastToast.at < 8000) return;
    lastToastRef.current = { msg, type, at: id };
    setToasts(prev => {
      const deduped = prev.filter(toast => toast.msg !== msg || toast.type !== type);
      return [...deduped.slice(-2), { id, msg, type }];
    });
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const markAccountExpired = useCallback((accountId: string, showMessage = true) => {
    if (expiredAccountsRef.current.has(accountId)) return;
    expiredAccountsRef.current.add(accountId);
    setExpiredAccountIds(new Set(expiredAccountsRef.current));

    // Per-account notification (only when single account expires, not via markSessionExpired)
    if (showMessage) {
      const email = accountsRef.current.find(a => a.id === accountId)?.email ?? accountId;
      showToast(`${email} session expired. Please sign in again.`, "error");
    }

    // All accounts expired → banner + stop sync
    const allExpired = accountsRef.current.every(a => expiredAccountsRef.current.has(a.id));
    if (allExpired && !tokenExpiredRef.current) {
      tokenExpiredRef.current = true;
      setTokenExpired(true);
      setIsUserSyncing(false);
      setIsBackgroundSyncing(false);
      syncChainIdRef.current++;
      if (syncIntervalRef.current !== null) {
        clearTimeout(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    }
  }, [showToast]);

  // backward-compat alias used in a few places
  const markSessionExpired = useCallback((showMessage = true) => {
    accountsRef.current.forEach(a => markAccountExpired(a.id, false));
    if (showMessage) showToast(AUTH_RELOGIN_MESSAGE, "error");
  }, [markAccountExpired, showToast]);

  const openExternalMailUrl = useCallback((url: string) => {
    if (!url || url.startsWith("#")) return;
    let normalized: string;
    try {
      normalized = new URL(url, "https://mail.google.com/").href;
    } catch {
      showToast(tr.actions.openLinkFailed, "error");
      return;
    }
    if (!/^(https?:|mailto:|tel:)/i.test(normalized)) {
      showToast(tr.actions.openLinkFailed, "error");
      return;
    }
    openUrl(normalized).catch((err) => {
      console.error("Failed to open mail link:", err);
      showToast(tr.actions.openLinkFailed, "error");
    });
  }, [showToast]);

  const shouldDeferNetworkForGameMode = useCallback(async (userInitiated = false) => {
    if (userInitiated || !pauseOnFullscreenRef.current) return false;
    try {
      return await invoke<boolean>("is_system_fullscreen");
    } catch (e) {
      console.error("Fullscreen check failed:", e);
      return false;
    }
  }, []);

  const checkForUpdates = async (showUIMessages = false) => {
    try {
      if (showUIMessages) setIsCheckingUpdate(true);
      setUpdateError(null);
      setUpdateStatus("");
      if (await shouldDeferNetworkForGameMode(showUIMessages)) {
        console.log("System in fullscreen/game mode, skipping automatic update check.");
        return;
      }
      const update = await check();
      if (update) {
        setUpdateAvailable({ version: update.version, date: update.date || "", body: update.body || "" });
        setUpdateStatus(tr.update.available.replace("{version}", update.version));
        if (showUIMessages) {
          showToast(`New update available: v${update.version}`, "info");
        } else if (notifiedUpdateVersionRef.current !== update.version) {
          notifiedUpdateVersionRef.current = update.version;
          await invoke("show_custom_notification", {
            title: "FURSOY Mail update ready",
            body: `v${update.version} is available. Click to open the update screen.`,
            kind: "update", code: null, emailId: null, duration: 10000,
          });
        }
      } else {
        setUpdateAvailable(null);
        setUpdateStatus(tr.update.upToDate);
        if (showUIMessages) showToast("Already up to date.", "success");
      }
    } catch (e) {
      console.error("Update check failed:", e);
      if (isNoUpdateError(e)) {
        setUpdateAvailable(null);
        setUpdateError(null);
        setUpdateStatus(tr.update.upToDate);
        if (showUIMessages) showToast("Already up to date.", "success");
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setUpdateError(`${tr.update.checkFailed}: ${message}`);
      setUpdateStatus("");
      if (showUIMessages) showToast("Update check failed.", "error");
    } finally {
      if (showUIMessages) setIsCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    try {
      setUpdateError(null);
      setUpdateStatus("");
      const update = await check();
      if (!update) {
        setUpdateAvailable(null);
        setUpdateStatus(tr.update.upToDate);
        return;
      }
      setUpdateProgress({ downloaded: 0, total: 100 });
      let downloaded = 0;
      let totalLength = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            totalLength = event.data.contentLength || 0;
            setUpdateProgress({ downloaded: 0, total: totalLength });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setUpdateProgress({ downloaded, total: totalLength });
            break;
          case "Finished":
            setUpdateProgress(null);
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error("Update install failed", e);
      if (isNoUpdateError(e)) {
        setUpdateAvailable(null);
        setUpdateError(null);
        setUpdateStatus(tr.update.upToDate);
        setUpdateProgress(null);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setUpdateError(`${tr.update.installFailed}: ${message}`);
      setUpdateProgress(null);
    }
  };

  useEffect(() => {
    const openNotificationMail = async (messageId: string, accountId?: string) => {
      if (!messageId || !accountId) return;
      if (accountId && accountId !== activeAccountIdRef.current) {
        setActiveAccountId(accountId);
        activeAccountIdRef.current = accountId;
        tabEmailCacheRef.current = {};
      }
      setMobileMenuOpen(false);
      setSinglePanelView("reader");
      activeTabRef.current = "inbox";
      mailListRequestIdRef.current += 1;
      startTabTransition(() => setActiveTab("inbox"));
      setSelectedMail(mailKey(accountId, messageId));
      setNotificationFocusVersion(version => version + 1);
      await loadEmails("inbox");
      await getCurrentWindow().show();
      await getCurrentWindow().unminimize();
      await getCurrentWindow().setFocus();
    };

    const unlistenCustomPromise = listen<{ emailId?: string; accountId?: string }>("open-notification-mail", async (event) => {
      await openNotificationMail(event.payload?.emailId || "", event.payload?.accountId);
    });
    const unlistenPluginPromise = listen<{ actionId: string; notification: { title: string; body: string } }>(
      "notification-action",
      async (event) => {
        const payload = event.payload?.notification;
        if (!payload) return;
        const key = (payload.title || "") + (payload.body || "");
        const mail = recentNotificationsRef.current[key];
        if (mail) await openNotificationMail(mail.messageId, mail.accountId);
      }
    );
    const unlistenUpdatePromise = listen("open-update-settings", async () => {
      setMobileMenuOpen(false);
      activeTabRef.current = "settings";
      mailListRequestIdRef.current += 1;
      startTabTransition(() => setActiveTab("settings"));
      await getCurrentWindow().show();
      await getCurrentWindow().unminimize();
      await getCurrentWindow().setFocus();
      window.setTimeout(() => {
        document.getElementById("settings-updates")?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
    });

    return () => {
      unlistenCustomPromise.then(unlisten => unlisten());
      unlistenPluginPromise.then(unlisten => unlisten());
      unlistenUpdatePromise.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void checkForUpdates(false); }, STARTUP_UPDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const isMailContextCurrent = (label: string, accountId: string | null) =>
    activeTabRef.current === label && activeAccountIdRef.current === accountId;

  const mailCacheKey = (label: string, accountId: string | null) =>
    `${accountId ?? "__all_accounts__"}\u0000${label}`;

  const loadEmails = async (tab?: string, options?: { append?: boolean; cursor?: EmailSummary | null }) => {
    try {
      const label = tab || activeTabRef.current;
      if (!MAIL_TABS.has(label)) {
        startDataTransition(() => setEmails([]));
        return [];
      }
      const accountId = activeAccountIdRef.current; // null = all accounts
      const cursor = options?.cursor ?? null;
      const requestId = ++mailListRequestIdRef.current;
      const result = await invoke<EmailSummary[]>("get_emails_by_label", {
        label,
        accountId,
        limit: MAIL_PAGE_SIZE,
        beforeDate: cursor?.date ?? null,
        beforeAccountId: cursor?.account_id ?? null,
        beforeId: cursor?.id ?? null,
      });
      if (requestId !== mailListRequestIdRef.current || !isMailContextCurrent(label, accountId)) {
        return [];
      }
      const adjusted = result.map(m =>
        recentlyReadRef.current.has(emailKey(m)) ? { ...m, unread: false } : m
      );
      if (!options?.append) {
        setHasMoreEmails(adjusted.length === MAIL_PAGE_SIZE);
      }
      if (adjusted.length > 0) {
        mailPageCursorRef.current = adjusted[adjusted.length - 1];
      }
      const cacheKey = mailCacheKey(label, accountId);
      tabEmailCacheRef.current[cacheKey] = options?.append
        ? [...(tabEmailCacheRef.current[cacheKey] ?? []), ...adjusted]
        : adjusted;
      const cacheKeys = Object.keys(tabEmailCacheRef.current);
      while (cacheKeys.length > MAX_LABEL_CACHE) {
        const oldest = cacheKeys.shift();
        if (oldest && oldest !== cacheKey) delete tabEmailCacheRef.current[oldest];
      }
      startDataTransition(() => {
        setEmails(previous => {
          if (!options?.append) return adjusted;
          const seen = new Set(previous.map(emailKey));
          return [...previous, ...adjusted.filter(email => !seen.has(emailKey(email)))];
        });
        if (options?.append && adjusted.length > 0) {
          setMailAppendVersion(version => version + 1);
        }
      });
      return adjusted;
    } catch (e) {
      console.error("Failed to load emails:", e);
      return [];
    }
  };

  const resetMailPagination = () => {
    mailListRequestIdRef.current += 1;
    mailPageCursorRef.current = null;
    isLoadingMoreEmailsRef.current = false;
    setHasMoreEmails(true);
    setIsLoadingMoreEmails(false);
  };

  const loadOlderEmails = async () => {
    const label = activeTabRef.current;
    const accountId = activeAccountIdRef.current;
    if (!MAIL_TABS.has(label) || !hasMoreEmails || isLoadingMoreEmailsRef.current) return false;

    isLoadingMoreEmailsRef.current = true;
    setIsLoadingMoreEmails(true);
    try {
      const page = await loadEmails(label, { append: true, cursor: mailPageCursorRef.current });
      const status = await invoke<MailboxDownloadStatus>("get_mailbox_download_status", {
        accountId,
      }).catch(() => ({ running: false, pending: false, state: "completed" as const, retryAfter: null }));
      if (!isMailContextCurrent(label, accountId)) return false;
      if (page.length === 0 && status.pending && !status.running) {
        // Never block the list on Gmail. Request a safe per-account sync and
        // let the existing background worker populate SQLite asynchronously.
        const targets = accountId
          ? [{ id: accountId, token: accountTokensRef.current[accountId] }]
          : accountsRef.current.map(account => ({ id: account.id, token: accountTokensRef.current[account.id] }));
        void Promise.allSettled(
          targets
            .filter((target): target is { id: string; token: string } => !!target.token)
            .map(target => invoke("sync_emails", { accountId: target.id, accessToken: target.token, force: true }))
        );
      }
      setIsMailboxBackfilling(status.running);
      setMailboxDownloadPending(status.pending);
      setMailboxDownloadState(status.state);
      setHasMoreEmails(page.length === MAIL_PAGE_SIZE || status.running || status.pending);
      return page.length > 0;
    } catch (error) {
      console.error("Failed to load older emails:", error);
      showToast(tr.mail.loadOlderFailed, "error");
      return false;
    } finally {
      if (isMailContextCurrent(label, accountId)) {
        isLoadingMoreEmailsRef.current = false;
        setIsLoadingMoreEmails(false);
      }
    }
  };

  const resetLocalMailbox = () => {
    if (isResettingLocalMailbox) return;
    setConfirmModal({
      message: tr.localMailbox.confirm,
      onConfirm: async () => {
        setIsResettingLocalMailbox(true);
        try {
          // Make the reset visible immediately. If the local delete fails, the
          // current list is loaded again below instead of leaving stale rows up.
          tabEmailCacheRef.current = {};
          setEmails([]);
          setSelectedMail(null);
          setSelectedMailBody("");
          setSelectedMailBodyId(null);
          resetMailPagination();
          await invoke("reset_local_mail_cache", { accountId: null });
          recentNotificationsRef.current = {};
          recentlyReadRef.current.clear();
          knownEmailIdsRef.current.clear();
          notificationReadyAccountIdsRef.current.clear();
          notificationBaselineEpochRef.current += 1;
          await backgroundSyncRef.current({ userInitiated: true, suppressNotifications: true });
          showToast(tr.localMailbox.resetSuccess, "success");
        } catch (error) {
          console.error("Failed to reset local mailbox:", error);
          showToast(tr.localMailbox.resetFailed, "error");
          void loadEmails(activeTabRef.current);
        } finally {
          setIsResettingLocalMailbox(false);
        }
      },
    });
  };

  const handleLaunchAtStartupChange = async (checked: boolean) => {
    setStartupSettingLoading(true);
    const previous = launchAtStartup;
    setLaunchAtStartup(checked);
    try {
      const actual = await invoke<boolean>("set_launch_at_startup", { enabled: checked });
      setLaunchAtStartup(actual);
      showToast(actual ? tr.startup.enabled : tr.startup.disabled, "success");
    } catch (e) {
      console.error("Failed to update startup setting:", e);
      setLaunchAtStartup(previous);
      showToast(`${tr.startup.failed}: ${e}`, "error");
    } finally {
      setStartupSettingLoading(false);
    }
  };

  const updateAppControls = async (next: AppControls) => {
    const previous = appControlsRef.current;
    const merged = { ...DEFAULT_APP_CONTROLS, ...next };
    setAppControls(merged);
    try {
      const saved = await invoke<AppControls>("set_app_controls", { controls: merged });
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...saved });
    } catch (e) {
      console.error("Failed to update app controls:", e);
      setAppControls(previous);
      showToast(`Setting could not be saved: ${e}`, "error");
    }
  };

  const syncAccountWithAutoRefresh = useCallback(async (accountId: string, token: string, force = false): Promise<string> => {
    try {
      await invoke("sync_emails", { accountId, accessToken: token, force });
      return token;
    } catch (e: unknown) {
      if (isAuthFailure(e)) {
        try {
          const refreshed = await invoke<AuthInfo>("refresh_access_token", { accountId });
          const newToken = refreshed.access_token;
          accountTokensRef.current = { ...accountTokensRef.current, [accountId]: newToken };
          setAccountTokens(prev => ({ ...prev, [accountId]: newToken }));
          expiredAccountsRef.current.delete(accountId);
          setExpiredAccountIds(new Set(expiredAccountsRef.current));
          tokenExpiredRef.current = false;
          setTokenExpired(false);
          await invoke("sync_emails", { accountId, accessToken: newToken, force });
          return newToken;
        } catch (refreshError) {
          console.error(`Token refresh failed for ${accountId}:`, refreshError);
          markAccountExpired(accountId);
          throw new Error(AUTH_RELOGIN_MESSAGE);
        }
      }
      throw e;
    }
  }, [markAccountExpired]);

  const adjustUnreadBadge = (accountId: string, delta: number) => {
    const activeAccountId = activeAccountIdRef.current;
    if (activeAccountId !== null && activeAccountId !== accountId) return;

    const now = Date.now();
    const previous = pendingUnreadBadgeDeltasRef.current.get(accountId);
    const nextDelta = (previous?.expiresAt && previous.expiresAt > now ? previous.delta : 0) + delta;
    if (nextDelta === 0) {
      pendingUnreadBadgeDeltasRef.current.delete(accountId);
    } else {
      // Gmail's label counters can lag a successful message modification briefly.
      pendingUnreadBadgeDeltasRef.current.set(accountId, { delta: nextDelta, expiresAt: now + 30_000 });
    }
    setInboxUnread(current => Math.max(0, current + delta));
  };

  const refreshUnreadCount = async () => {
    try {
      const accountId = activeAccountIdRef.current;
      const count = await invoke<number>("get_inbox_unread_count", { accountId });
      const now = Date.now();
      let pendingDelta = 0;
      for (const [id, pending] of pendingUnreadBadgeDeltasRef.current) {
        if (pending.expiresAt <= now) {
          pendingUnreadBadgeDeltasRef.current.delete(id);
        } else if (accountId === null || accountId === id) {
          pendingDelta += pending.delta;
        }
      }
      startDataTransition(() => setInboxUnread(Math.max(0, count + pendingDelta)));
      return count;
    } catch { return 0; }
  };

  const notifyNewEmails = useCallback(async (newEmails: EmailSummary[]) => {
    if (newEmails.length === 0) return;
    const controls = appControlsRef.current;
    if (controls.notificationsMuted || isInQuietHours(controls)) return;
    try {
      for (const email of newEmails.slice(0, 5)) {
        const senderName = email.sender.split("<")[0].replace(/"/g, "").trim() || email.sender;
        const body = otpMode === "off" ? "" : await invoke<string>("get_email_body", { id: email.id, accountId: email.account_id }).catch(() => "");
        const code = extractVerificationCode({ ...email, body_html: body }, otpMode, appLanguage);
        const account = accountsRef.current.find(a => a.id === email.account_id);
        const title = senderName.slice(0, 64);
        const notificationBody = (email.subject || email.snippet || "").trim().slice(0, 100) || "New message";
        const notificationKey = title + notificationBody;
        const previous = recentNotificationsRef.current[notificationKey];
        recentNotificationsRef.current[notificationKey] = previous &&
          (previous.accountId !== email.account_id || previous.messageId !== email.id)
          ? null
          : { accountId: email.account_id, messageId: email.id };
        await invoke("show_custom_notification", {
          title,
          body: notificationBody,
          kind: "mail",
          code: code || null,
          emailId: email.id,
          duration: notifInfiniteRef.current ? 0 : notifDurationRef.current * 1000,
          accountId: email.account_id || null,
          accountPicture: account?.picture || null,
          multiAccount: accountsRef.current.length > 1,
        });
      }
    } catch (e) {
      console.error("Notification error:", e);
    }
  }, [otpMode]);

  const clearPeriodicSync = () => {
    syncChainIdRef.current++;
    if (syncIntervalRef.current !== null) {
      clearTimeout(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  };

  const startPeriodicSync = () => {
    clearPeriodicSync();
    const chainId = syncChainIdRef.current;
    const scheduleNext = () => {
      if (syncChainIdRef.current !== chainId) return;
      syncIntervalRef.current = window.setTimeout(async () => {
        if (syncChainIdRef.current !== chainId) return;
        const hasAnyToken = Object.keys(accountTokensRef.current).length > 0;
        if (hasAnyToken && !tokenExpiredRef.current) {
          await backgroundSyncRef.current();
        }
        scheduleNext();
      }, syncIntervalValueRef.current * 1000);
    };
    scheduleNext();
  };

  useEffect(() => {
    if (Object.keys(accountTokens).length > 0) startPeriodicSync();
  }, [syncIntervalValue]);

  const backgroundSync = async (opts?: { userInitiated?: boolean; suppressNotifications?: boolean }): Promise<boolean> => {
    const accts = accountsRef.current;
    const tokens = accountTokensRef.current;
    if (accts.length === 0) return false;

    const userInitiated = opts?.userInitiated ?? false;
    const notificationBaselineEpoch = notificationBaselineEpochRef.current;
    if (appControlsRef.current.mailSyncPaused && !userInitiated) return false;
    if (await shouldDeferNetworkForGameMode(userInitiated)) {
      console.log("System in fullscreen/game mode, skipping background sync.");
      return false;
    }

    try {
      if (userInitiated) setIsUserSyncing(true);
      else setIsBackgroundSyncing(true);

      let anySuccess = false;
      const successfullySyncedAccountIds = new Set<string>();
      for (const account of accts) {
        const token = tokens[account.id];
        if (!token || expiredAccountsRef.current.has(account.id)) continue;
        try {
          await syncAccountWithAutoRefresh(account.id, token, userInitiated);
          anySuccess = true;
          successfullySyncedAccountIds.add(account.id);
        } catch (e) {
          if (!isAuthFailure(e)) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Sync failed for ${account.id}:`, msg);
          }
        }
      }

      if (anySuccess) {
        const freshInbox = await invoke<EmailSummary[]>("get_emails_by_label", { label: "inbox", accountId: null });
        const readyAccountIds = notificationReadyAccountIdsRef.current;
        const suppressNotifications = opts?.suppressNotifications === true ||
          notificationBaselineEpoch !== notificationBaselineEpochRef.current;
        const newUnreadEmails = freshInbox.filter(
          e => !suppressNotifications && e.unread && readyAccountIds.has(e.account_id) && !knownEmailIdsRef.current.has(emailKey(e))
        );
        knownEmailIdsRef.current = new Set(freshInbox.map(emailKey));
        // The first successful sync for an account establishes its baseline.
        // Existing cache and initial Gmail history never create notifications.
        for (const accountId of successfullySyncedAccountIds) readyAccountIds.add(accountId);
        notifyNewEmails(newUnreadEmails);

        // Do not replace a list the user has paged through while background
        // sync is running; new mail will appear on the next refresh instead.
        if (MAIL_TABS.has(activeTabRef.current) && emails.length <= MAIL_PAGE_SIZE) {
          await loadEmails();
        }
        await refreshUnreadCount();
      }

      return anySuccess;
    } catch (e) {
      console.error("Background sync failed:", e);
      if (isAuthFailure(e)) { markSessionExpired(); return false; }
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Sync failed: ${msg}`, "error");
      return false;
    } finally {
      if (userInitiated) setIsUserSyncing(false);
      else setIsBackgroundSyncing(false);
    }
  };

  backgroundSyncRef.current = backgroundSync;

  useEffect(() => {
    let cancelled = false;
    let startupSyncTimer: number | null = null;

    refreshUnreadCount();

    // Multi-account startup: load all accounts and their tokens
    invoke<Account[]>("get_accounts")
      .then(async (loadedAccounts) => {
        setAccountsLoaded(true);
        if (loadedAccounts.length === 0) return;

        setAccounts(loadedAccounts);
        accountsRef.current = loadedAccounts;

        // Primary account (first by display_order) becomes active
        const primary = loadedAccounts[0];
        setActiveAccountId(primary.id);
        activeAccountIdRef.current = primary.id;

        // Load tokens for each account
        const tokens: Record<string, string> = {};
        for (const acc of loadedAccounts) {
          try {
            const auth = await invoke<AuthInfo | null>("get_account_auth", { accountId: acc.id });
            if (auth?.access_token) tokens[acc.id] = auth.access_token;
          } catch (e) {
            console.error(`Failed to load auth for ${acc.id}:`, e);
          }
        }
        setAccountTokens(tokens);
        accountTokensRef.current = tokens;

        startupSyncTimer = window.setTimeout(() => {
          void (async () => {
            if (cancelled) return;
            if (await shouldDeferNetworkForGameMode(false)) {
              console.log("System in fullscreen/game mode, delaying startup sync.");
            } else {
              // Refresh tokens for all accounts — even those with no cached access token,
              // since refresh_access_token reads the refresh token directly from keyring.
              for (const acc of loadedAccounts) {
                try {
                  const refreshed = await invoke<AuthInfo>("refresh_access_token", { accountId: acc.id });
                  if (cancelled) return;
                  accountTokensRef.current = { ...accountTokensRef.current, [acc.id]: refreshed.access_token };
                  setAccountTokens(prev => ({ ...prev, [acc.id]: refreshed.access_token }));
                  expiredAccountsRef.current.delete(acc.id);
                  setExpiredAccountIds(new Set(expiredAccountsRef.current));
                } catch (refreshError) {
                  if (isAuthFailure(refreshError)) {
                    // Only force re-login if we also have no cached token.
                    // If there IS a cached token, the keyring failure may be transient
                    // (Windows Credential Manager timing issue in dev mode).
                    // The sync will naturally detect expiry when the cached token stops working.
                    if (!accountTokensRef.current[acc.id]) {
                      markAccountExpired(acc.id);
                    } else {
                      console.warn(`Startup refresh failed for ${acc.id} (cached token in use):`, refreshError);
                    }
                  } else {
                    console.log(`Token refresh skipped for ${acc.id}:`, refreshError);
                  }
                }
              }

              if (!cancelled && Object.keys(accountTokensRef.current).length > 0) {
                await backgroundSyncRef.current();
              }
            }
            if (!cancelled) startPeriodicSync();
          })();
        }, STARTUP_NETWORK_DELAY_MS);
      })
      .catch(console.error);

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape") {
        setShowReply(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    const unlistenFocus = listen("focus-main-window", async () => {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
    });

    const handleIframeMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "open_url" && typeof e.data.url === "string") {
        openExternalMailUrl(e.data.url);
      }
    };
    window.addEventListener("message", handleIframeMessage);

    return () => {
      cancelled = true;
      if (startupSyncTimer !== null) window.clearTimeout(startupSyncTimer);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleIframeMessage);
      clearPeriodicSync();
      unlistenFocus.then(f => f());
    };
  }, [openExternalMailUrl, shouldDeferNetworkForGameMode, markSessionExpired]);

  useEffect(() => {
    if (!MAIL_TABS.has(activeTab)) {
      startDataTransition(() => setEmails([]));
      return;
    }
    resetMailPagination();
    const cached = tabEmailCacheRef.current[mailCacheKey(activeTab, activeAccountId)];
    if (cached !== undefined) setEmails(cached);
    void loadEmails(activeTab);
  }, [activeTab, activeAccountId]);

  useEffect(() => {
    if (!accountsLoaded) return;
    let cancelled = false;
    const label = activeTab;
    const accountId = activeAccountId;
    const refreshBackfillStatus = async () => {
      const status = await invoke<MailboxDownloadStatus>("get_mailbox_download_status", {
        accountId,
      }).catch(() => ({ running: false, pending: false, state: "completed" as const, retryAfter: null }));
      if (!cancelled && isMailContextCurrent(label, accountId)) {
        setIsMailboxBackfilling(status.running);
        setMailboxDownloadPending(status.pending);
        setMailboxDownloadState(status.state);
        if (!status.running && !status.pending && MAIL_TABS.has(label)) {
          const cursor = mailPageCursorRef.current;
          const nextPage = await invoke<EmailSummary[]>("get_emails_by_label", {
            label,
            accountId,
            limit: 1,
            beforeDate: cursor?.date ?? null,
            beforeAccountId: cursor?.account_id ?? null,
            beforeId: cursor?.id ?? null,
          }).catch(() => []);
          if (!cancelled && isMailContextCurrent(label, accountId)) setHasMoreEmails(nextPage.length > 0);
        }
      }
    };
    void refreshBackfillStatus();
    const timer = window.setInterval(() => { void refreshBackfillStatus(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountsLoaded, activeAccountId, activeTab]);

  useEffect(() => {
    const query = searchQuery.trim();
    const requestId = ++searchRequestIdRef.current;
    if (!query) {
      setSearchResults(null);
      return;
    }

    const accountId = activeAccountId;
    const timer = window.setTimeout(() => {
      void invoke<EmailSummary[]>("search_local_emails", {
        query,
        accountId,
        limit: 500,
      })
        .then(results => {
          if (
            searchRequestIdRef.current !== requestId ||
            activeAccountIdRef.current !== accountId
          ) return;
          setSearchResults(results);
        })
        .catch(error => {
          if (searchRequestIdRef.current !== requestId) return;
          console.error("Local email search failed:", error);
          setSearchResults([]);
        });
    }, 150);

    return () => window.clearTimeout(timer);
  }, [searchQuery, activeAccountId]);

  useEffect(() => {
    if (activeTab !== "settings") return;
    const timer = window.setTimeout(() => {
      invoke<boolean>("get_launch_at_startup").then(setLaunchAtStartup).catch(console.error);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeTab]);

  const goToTab = (tab: typeof activeTab) => {
    setSelectedMail(null);
    setShowReply(false);
    setSinglePanelView("list");
    setMobileMenuOpen(false);
    activeTabRef.current = tab;
    mailListRequestIdRef.current += 1;
    startTabTransition(() => setActiveTab(tab));
  };

  async function loginWithGoogle() {
    setIsConnecting(true);
    try {
      setAuthStatus(tr.auth.waitingForBrowser);
      const res = await invoke<AuthInfo>("start_google_oauth");

      // Update accounts list
      const updatedAccounts = await invoke<Account[]>("get_accounts");
      setAccounts(updatedAccounts);
      accountsRef.current = updatedAccounts;

      // Store new token
      accountTokensRef.current = { ...accountTokensRef.current, [res.email]: res.access_token };
      setAccountTokens(prev => ({ ...prev, [res.email]: res.access_token }));
      expiredAccountsRef.current.delete(res.email);
      setExpiredAccountIds(new Set(expiredAccountsRef.current));

      // If this is the first account, set it active
      if (updatedAccounts.length === 1) {
        setActiveAccountId(res.email);
        activeAccountIdRef.current = res.email;
      }

      setAuthStatus(tr.auth.loggedInSyncing);
      const stillExpired = expiredAccountsRef.current.size > 0;
      tokenExpiredRef.current = stillExpired;
      if (!stillExpired) setTokenExpired(false);
      // The first download for a newly added account is a baseline, not new-mail activity.
      const ok = await backgroundSyncRef.current({ userInitiated: true, suppressNotifications: true });
      if (ok) {
        setAuthStatus(tr.auth.syncComplete);
        showToast("Signed in!", "success");
      } else {
        setAuthStatus(tr.auth.syncFailedAfterLogin);
      }
      startPeriodicSync();
    } catch (e) {
      setAuthStatus("Error: " + e);
      setIsUserSyncing(false);
      showToast("Sign-in failed: " + e, "error");
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleLogoutAccount(accountId: string) {
    try {
      await invoke("remove_account", { accountId });

      // Remove from local state
      const newTokens = { ...accountTokensRef.current };
      delete newTokens[accountId];
      accountTokensRef.current = newTokens;
      setAccountTokens(newTokens);
      expiredAccountsRef.current.delete(accountId);
      setExpiredAccountIds(new Set(expiredAccountsRef.current));
      notificationReadyAccountIdsRef.current.delete(accountId);
      const removedAccountPrefix = `${accountId}\u0000`;
      knownEmailIdsRef.current = new Set(
        [...knownEmailIdsRef.current].filter(key => !key.startsWith(removedAccountPrefix))
      );

      const updatedAccounts = await invoke<Account[]>("get_accounts");
      setAccounts(updatedAccounts);
      accountsRef.current = updatedAccounts;

      // Switch active account if needed
      if (activeAccountIdRef.current === accountId) {
        const nextId = updatedAccounts.length > 0 ? updatedAccounts[0].id : null;
        setActiveAccountId(nextId);
        activeAccountIdRef.current = nextId;
      }

      if (updatedAccounts.length === 0) {
        clearPeriodicSync();
        tokenExpiredRef.current = false;
        setTokenExpired(false);
        setEmails([]);
        setSelectedMail(null);
        setSelectedMailBody("");
        setSelectedMailBodyId(null);
        setAuthStatus(tr.auth.loggedOut);
      } else {
        // Reload emails for remaining account context
        tabEmailCacheRef.current = {};
        await loadEmails(activeTabRef.current);
        await refreshUnreadCount();
      }
      showToast("Signed out", "success");
    } catch (e) {
      console.error("Logout failed:", e);
      showToast("Sign-out failed: " + e, "error");
    }
  }

  async function handleReorderAccounts(orderedIds: string[]) {
    try {
      await invoke("reorder_accounts", { orderedIds });
      const updatedAccounts = await invoke<Account[]>("get_accounts");
      setAccounts(updatedAccounts);
      accountsRef.current = updatedAccounts;
    } catch (e) {
      console.error("Reorder failed:", e);
    }
  }

  async function handleSwitchAccount(accountId: string | null) {
    setActiveAccountId(accountId);
    activeAccountIdRef.current = accountId;
    tabEmailCacheRef.current = {};
    resetMailPagination();
    setSelectedMail(null);
    await loadEmails(activeTabRef.current);
    await refreshUnreadCount();
  }

  const handleRefresh = async () => {
    if (Object.keys(accountTokensRef.current).length === 0) {
      showToast("Please sign in first.", "error");
      return;
    }
    setAuthStatus("Syncing...");
    const ok = await backgroundSyncRef.current({ userInitiated: true });
    if (ok) {
      setAuthStatus("Up to date.");
      showToast("Inbox updated", "success");
    } else {
      setAuthStatus("Sync failed. Check your network or session.");
      showToast(tr.mail.syncFailed, "error");
      const status = await invoke<MailboxDownloadStatus>("get_mailbox_download_status", {
        accountId: activeAccountIdRef.current,
      }).catch(() => null);
      if (status) {
        setIsMailboxBackfilling(status.running);
        setMailboxDownloadPending(status.pending);
        setMailboxDownloadState(status.state);
      }
    }
  };

  const handleMailClick = async (mail: EmailSummary) => {
    setSelectedMail(emailKey(mail));
    if (mailViewMode !== "split") setSinglePanelView("reader");
    setShowReply(false);
    setReplyText("");
    if (mail.unread) {
      recentlyReadRef.current.add(emailKey(mail));
      setEmails(prev => prev.map(m => sameEmail(m, mail) ? { ...m, unread: false } : m));
      setSearchResults(prev => prev?.map(m => sameEmail(m, mail) ? { ...m, unread: false } : m) ?? null);
      adjustUnreadBadge(mail.account_id, -1);
      try {
        await invoke("mark_as_read", { accountId: mail.account_id, accessToken: getTokenForEmail(mail), messageId: mail.id });
      } catch (e) {
        console.error("Failed to mark as read:", e);
        recentlyReadRef.current.delete(emailKey(mail));
        setEmails(prev => prev.map(m => sameEmail(m, mail) ? { ...m, unread: true } : m));
        setSearchResults(prev => prev?.map(m => sameEmail(m, mail) ? { ...m, unread: true } : m) ?? null);
        setThreadEmails(prev => prev.map(m => sameEmail(m, mail) ? { ...m, unread: true } : m));
        adjustUnreadBadge(mail.account_id, 1);
      }
    }
  };

  const handleArchive = async (mail: EmailSummary) => {
    const token = getTokenForEmail(mail);
    if (!mail || !token) return;
    setEmails(prev => prev.map(e => sameEmail(e, mail) ? { ...e, label: "archive" } : e));
    setSelectedMail(null);
    try {
      await invoke("archive_email", { accountId: mail.account_id, accessToken: token, messageId: mail.id });
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch {
      showToast("Archive failed", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleTrash = async (mail: EmailSummary) => {
    const token = getTokenForEmail(mail);
    if (!mail || !token) return;
    setEmails(prev => prev.map(e => sameEmail(e, mail) ? { ...e, label: "trash" } : e));
    setSelectedMail(null);
    try {
      await invoke("trash_email", { accountId: mail.account_id, accessToken: token, messageId: mail.id });
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch {
      showToast("Delete failed", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleMoveToInbox = async (mail: EmailSummary) => {
    const token = getTokenForEmail(mail);
    if (!mail || !token) return;
    setEmails(prev => prev.filter(e => !sameEmail(e, mail)));
    setSelectedMail(null);
    try {
      await invoke("move_to_inbox", { accountId: mail.account_id, accessToken: token, messageId: mail.id });
      showToast("Moved to inbox", "success");
      void loadEmails(activeTabRef.current);
      void refreshUnreadCount();
    } catch {
      showToast("Move failed", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handlePermanentDelete = (mail: EmailSummary) => {
    const token = getTokenForEmail(mail);
    if (!mail || !token) return;
    setConfirmModal({
      message: "Permanently delete this email? This cannot be undone.",
      onConfirm: async () => {
        setEmails(prev => prev.filter(e => !sameEmail(e, mail)));
        setSelectedMail(null);
        try {
          await invoke("permanently_delete", { accountId: mail.account_id, accessToken: token, messageId: mail.id });
          showToast("Permanently deleted", "success");
        } catch {
          showToast("Delete failed", "error");
          loadEmails(activeTabRef.current);
        }
      },
    });
  };

  const handleReply = async (replyAttachments: import("./types").AttachmentPayload[] = [], body = "") => {
    if (!activeMail || !body.trim()) return;
    const accessToken = getTokenForEmail(activeMail);
    if (!accessToken) return;
    setIsSending(true);
    try {
      const extractAddress = (raw: string) => {
        const m = raw.match(/<([^>]+)>/);
        return m ? m[1].trim() : raw.trim();
      };
      const senderAddr = extractAddress(activeMail.sender);
      let toField: string;
      if (replyMode === "reply-all") {
        const myAddr = activeMail.account_id ?? "";
        const toAddrs = activeMail.recipient
          .split(",")
          .map(a => extractAddress(a.trim()))
          .filter(a => a.length > 0 && a.toLowerCase() !== myAddr.toLowerCase());
        const ccAddrs = activeMail.cc
          .split(",")
          .map(a => extractAddress(a.trim()))
          .filter(a => a.length > 0 && a.toLowerCase() !== myAddr.toLowerCase());
        toField = [senderAddr, ...toAddrs, ...ccAddrs].join(", ");
      } else {
        toField = senderAddr;
      }
      const quotedDate = formatDateFull(activeMail.date);
      const quotedHtml = `<br/><br/><div style="border-left:3px solid #ccc;padding-left:12px;color:#888;margin-top:8px"><div style="margin-bottom:6px;font-size:12px">On ${quotedDate}, <b>${activeMail.sender}</b> wrote:</div>${selectedMailBody || activeMail.snippet}</div>`;
      await invoke("send_reply", {
        accountId: activeMail.account_id,
        accessToken,
        to: toField,
        subject: activeMail.subject,
        body: body + quotedHtml,
        threadId: activeMail.thread_id || activeMail.id,
        messageId: activeMail.id,
        attachments: replyAttachments.length > 0 ? replyAttachments : null,
      });
      setReplyText("");
      setShowReply(false);
      setThreadRefreshKey(k => k + 1);
    } catch {
      showToast("Failed to send reply", "error");
    }
    setIsSending(false);
  };

  const handleComposeSend = async (attachments: import("./types").AttachmentPayload[], body: string) => {
    if (!composeTo.trim() || !composeSubject.trim()) return;
    const sendFromId = composeAccountId ?? activeAccountId ?? accounts[0]?.id;
    if (!sendFromId) { setComposeSendError("No account found to send from."); return; }

    setComposeSendError(null);
    setIsSending(true);

    // Resolve token — refresh if missing or stale
    let token = accountTokens[sendFromId];
    if (!token) {
      try {
        const refreshed = await invoke<AuthInfo>("refresh_access_token", { accountId: sendFromId });
        token = refreshed.access_token;
        accountTokensRef.current = { ...accountTokensRef.current, [sendFromId]: token };
        setAccountTokens(prev => ({ ...prev, [sendFromId]: token }));
        expiredAccountsRef.current.delete(sendFromId);
        setExpiredAccountIds(new Set(expiredAccountsRef.current));
      } catch {
        setComposeSendError("Session expired. Please sign in to your account again.");
        setIsSending(false);
        return;
      }
    }

    try {
      const finalBody = body + composeHtmlAppend;
      await invoke("send_email", { accessToken: token, to: composeTo, subject: composeSubject, body: finalBody, attachments: attachments.length > 0 ? attachments : null });
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      setComposeHtmlAppend("");
      setComposeSendError(null);
      showToast("Email sent", "success");
    } catch (e) {
      const raw = String(e);
      // Token expired mid-send → mark expired
      if (isAuthFailure(raw)) {
        markAccountExpired(sendFromId);
        setComposeSendError("Session expired. Please sign in again.");
      } else {
        const msg = raw.replace(/^Error:\s*/i, "").replace(/Gmail send error:\s*/i, "");
        setComposeSendError(msg || "Send failed. Please try again.");
      }
    }
    setIsSending(false);
  };

  const handleMarkAsUnread = async (mail: EmailSummary) => {
    const token = getTokenForEmail(mail);
    if (!mail || !token) return;
    recentlyReadRef.current.delete(emailKey(mail));
    setEmails(prev => prev.map(m => sameEmail(m, mail) ? { ...m, unread: true } : m));
    adjustUnreadBadge(mail.account_id, 1);
    try {
      await invoke("mark_as_unread", { accountId: mail.account_id, accessToken: token, messageId: mail.id });
    } catch {
      adjustUnreadBadge(mail.account_id, -1);
      showToast("Operation failed", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleForward = (mail: EmailSummary) => {
    const fwdHeader = `<br/><br/><div style="border-top:1px solid #eee;padding-top:12px;color:#555;font-size:13px"><b>---------- Forwarded Message ----------</b><br/>From: ${mail.sender}<br/>Subject: ${mail.subject}<br/>Date: ${formatDateFull(mail.date)}<br/><br/></div>`;
    setComposeTo("");
    setComposeSubject(`Fwd: ${mail.subject.replace(/^(Fwd:\s*)+/i, "")}`);
    setComposeBody("");
    setComposeHtmlAppend(fwdHeader + (selectedMailBody || mail.snippet));
    setComposeAccountId(mail.account_id ?? activeAccountId ?? accounts[0]?.id ?? null);
    setShowCompose(true);
  };

  const handleAppLanguageChange = async (language: AppLanguage) => {
    const previous = appLanguage;
    setAppLanguage(language);
    localStorage.setItem("fursoy_app_language", language);
    try {
      const saved = await invoke<AppControls>("set_app_language", { language });
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...saved });
    } catch (error) {
      console.error("Failed to save app language:", error);
      setAppLanguage(previous);
      localStorage.setItem("fursoy_app_language", previous);
    }
  };

  const canLoadRemoteImages = useCallback((mail: EmailSummary) => {
    if (remoteImageMode === "always" || loadedRemoteImageEmails.has(mail.id)) return true;
    if (remoteImageMode !== "trusted") return false;
    const sender = getSenderAddress(mail.sender);
    return !!sender && (trustedImageSenders[mail.account_id] ?? []).includes(sender);
  }, [loadedRemoteImageEmails, remoteImageMode, trustedImageSenders]);

  const handleLoadRemoteImages = useCallback((emailId: string) => {
    setLoadedRemoteImageEmails(previous => new Set(previous).add(emailId));
  }, []);

  const handleTrustRemoteImages = useCallback((mail: EmailSummary) => {
    const sender = getSenderAddress(mail.sender);
    if (!sender) return;
    setTrustedImageSenders(previous => {
      const senders = previous[mail.account_id] ?? [];
      if (senders.includes(sender)) return previous;
      const next = { ...previous, [mail.account_id]: [...senders, sender] };
      localStorage.setItem("fursoy_trusted_image_senders", JSON.stringify(next));
      return next;
    });
    handleLoadRemoteImages(mail.id);
  }, [handleLoadRemoteImages]);

  // --- Derived state ---
  const hasSearchQuery = searchQuery.trim().length > 0;
  const displayEmails = hasSearchQuery ? (searchResults ?? []) : emails;
  const activeMail = [...displayEmails, ...emails].find(m => emailKey(m) === selectedMail);
  const activeMailKey = activeMail ? emailKey(activeMail) : null;
  const selectedMailViewMode = mailViewPreference === "auto" ? getAutoMailViewMode(windowWidth) : mailViewPreference;
  const mailViewMode: MailViewMode = selectedMailViewMode === "single-toggle" ? "split" : selectedMailViewMode;

  useEffect(() => {
    if (mailViewPreference !== "auto") {
      previousAutoMailViewModeRef.current = null;
      return;
    }
    const previousMode = previousAutoMailViewModeRef.current;
    if (previousMode && previousMode !== mailViewMode) {
      if (mailViewMode === "split" || !selectedMail) setSinglePanelView("list");
      else setSinglePanelView("reader");
    }
    previousAutoMailViewModeRef.current = mailViewMode;
  }, [mailViewMode, mailViewPreference, selectedMail]);

  const closeReader = () => {
    if (selectedMailViewMode !== "single-toggle") setSelectedMail(null);
    setShowReply(false);
    setSinglePanelView("list");
  };

  const persistMailZoom = useCallback((zoom: MailZoom) => {
    setMailZoom(zoom);
    localStorage.setItem("fursoy_mail_zoom", zoom === "fit" ? "fit" : String(zoom));
  }, []);

  const stepMailZoom = useCallback((direction: 1 | -1) => {
    setMailZoom(prev => {
      const current = prev === "fit" ? mailFitScale : prev;
      let index = ZOOM_STEPS.findIndex(step => step >= current - 0.001);
      if (index === -1) index = ZOOM_STEPS.length - 1;
      if (direction < 0 && ZOOM_STEPS[index] > current + 0.001 && index > 0) index -= 1;
      const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
      const value = ZOOM_STEPS[next];
      localStorage.setItem("fursoy_mail_zoom", String(value));
      return value;
    });
  }, [mailFitScale]);

  const effectiveZoomPct = Math.round((mailZoom === "fit" ? mailFitScale : mailZoom) * 100);

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
    invoke<string>("get_email_body", { id: activeMail?.id, accountId: activeMail?.account_id })
      .then((body) => {
        if (cancelled) return;
        setSelectedMailBody(body || "");
        setSelectedMailBodyId(selectedMail);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load email body:", e);
        setBodyError(tr.mail.bodyLoadFailed);
      })
      .finally(() => { if (!cancelled) setIsBodyLoading(false); });

    return () => { cancelled = true; };
  }, [selectedMail, activeMailKey]);

  useEffect(() => {
    if (!activeMail || !activeMailKey) return;
    const token = getTokenForEmail(activeMail);
    if (!token) return;
    let cancelled = false;

    // The reader is already showing SQLite data. Refresh only this message in
    // the background, then replace the body only if it is still open.
    void invoke("refresh_email_from_gmail", {
      accountId: activeMail.account_id,
      accessToken: token,
      messageId: activeMail.id,
    })
      .then(() => invoke<string>("get_email_body", { id: activeMail.id, accountId: activeMail.account_id }))
      .then((body) => {
        if (cancelled || selectedMail !== activeMailKey) return;
        setSelectedMailBody(body || "");
        setSelectedMailBodyId(activeMailKey);
      })
      .catch(() => {
        // Local data remains usable when an individual Gmail refresh fails.
      });

    return () => { cancelled = true; };
  }, [activeMailKey]);

  useEffect(() => { setVerificationCopyState("idle"); }, [selectedMail]);

  const selectedMailThreadId = activeMail?.thread_id;
  useEffect(() => {
    if (!selectedMail || !selectedMailThreadId) { setThreadEmails([]); return; }
    let cancelled = false;
    invoke<EmailSummary[]>("get_thread_emails", { threadId: selectedMailThreadId, accountId: activeMail?.account_id })
      .then(all => {
        if (cancelled) return;
        setThreadEmails(all);
        for (const email of all) {
          if (email.unread && !recentlyReadRef.current.has(emailKey(email))) {
            recentlyReadRef.current.add(emailKey(email));
            setEmails(prev => prev.map(m => sameEmail(m, email) ? { ...m, unread: false } : m));
            setSearchResults(prev => prev?.map(m => sameEmail(m, email) ? { ...m, unread: false } : m) ?? null);
            adjustUnreadBadge(email.account_id, -1);
            const token = getTokenForEmail(email);
            if (token) {
              invoke("mark_as_read", { accountId: email.account_id, accessToken: token, messageId: email.id }).catch(error => {
                console.error("Failed to mark thread email as read:", error);
                recentlyReadRef.current.delete(emailKey(email));
                setEmails(prev => prev.map(m => sameEmail(m, email) ? { ...m, unread: true } : m));
                setSearchResults(prev => prev?.map(m => sameEmail(m, email) ? { ...m, unread: true } : m) ?? null);
                setThreadEmails(prev => prev.map(m => sameEmail(m, email) ? { ...m, unread: true } : m));
                adjustUnreadBadge(email.account_id, 1);
              });
            }
          }
        }
      })
      .catch(() => { if (!cancelled) setThreadEmails([]); });
    return () => { cancelled = true; };
  }, [selectedMail, selectedMailThreadId, threadRefreshKey]);

  const threadGroups = useMemo((): ThreadGroup[] => {
    const map = new Map<string, ThreadGroup>();
    for (const email of displayEmails) {
      const key = `${email.account_id}\u0000${email.thread_id || email.id}`;
      const name = email.sender.split("<")[0].replace(/"/g, "").trim() || email.sender;
      const ex = map.get(key);
      if (!ex) {
        map.set(key, { latestEmail: email, hasUnread: email.unread, count: 1, participants: [name] });
      } else {
        map.set(key, {
          latestEmail: email.date > ex.latestEmail.date ? email : ex.latestEmail,
          hasUnread: ex.hasUnread || email.unread,
          count: ex.count + 1,
          participants: ex.participants.includes(name) ? ex.participants : [...ex.participants, name],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.latestEmail.date - a.latestEmail.date);
  }, [displayEmails]);

  const unreadCount = inboxUnread;
  const hasLoadedActiveBody = !!activeMail && selectedMailBodyId === selectedMail;
  const verificationCode = activeMail && hasLoadedActiveBody
    ? extractVerificationCode({ ...activeMail, body_html: selectedMailBody }, otpMode, appLanguage)
    : null;
  const activeMailTab = activeMail?.label ?? activeTab;
  const showArchiveBtn = activeMailTab === "inbox" || activeMailTab === "sent";
  const showRestoreBtn = activeMailTab === "trash" || activeMailTab === "spam" || activeMailTab === "archive";
  const showTrashToBinBtn = activeMailTab !== "trash";
  const showDeleteForeverBtn = activeMailTab === "trash";
  const isCompactSidebarMode =
    mailViewPreference === "single-toggle" ||
    (mailViewPreference === "auto" && windowWidth >= 900 && windowWidth < 1280);
  const usesOverlaySidebar = windowWidth < 900 || isCompactSidebarMode;
  const showMailList = mailViewMode === "split" || !selectedMail || singlePanelView === "list";
  const showMailReader = !!activeMail && (mailViewMode === "split" || singlePanelView === "reader");
  const mailListClassName =
    mailViewMode === "split"
      ? `flex min-w-0 flex-col border-r border-white/5 bg-[#09090b] ${selectedMail ? "hidden md:flex md:w-80 lg:w-96" : "flex-1 md:w-80 lg:w-96 md:flex-none"}`
      : showMailList
      ? "flex min-w-0 flex-1 flex-col border-r border-white/5 bg-[#09090b]"
      : "hidden";
  const mailReaderClassName = showMailReader
    ? "flex-1 min-w-0 flex flex-col bg-[#0a0a0c] relative z-10 select-text"
    : "hidden";

  const handleMailViewPreferenceChange = (mode: MailViewPreference) => {
    setMailViewPreference(mode);
    localStorage.setItem("fursoy_mail_view_mode", mode);
    const nextMode = mode === "auto" ? getAutoMailViewMode(windowWidth) : mode;
    setSinglePanelView(
      nextMode === "split" || nextMode === "inbox-first" || !selectedMail ? "list" : singlePanelView
    );
  };

  if (accountsLoaded && accounts.length === 0) {
    return <Onboarding onConnect={loginWithGoogle} isConnecting={isConnecting} />;
  }

  return (
    <LocaleContext.Provider value={tr}>
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-300 font-sans overflow-hidden select-none">
      {/* CUSTOM TITLEBAR */}
      <div
        data-tauri-drag-region
        className="relative z-[60] h-9 shrink-0 flex items-center justify-between pl-2 pr-0 border-b border-white/5 bg-[#09090b]"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        onMouseDown={(event) => {
          if (!mobileMenuOpen) return;
          if ((event.target as HTMLElement).closest("button")) return;
          setMobileMenuOpen(false);
        }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium text-zinc-500 pl-1">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(open => !open)}
            className="hidden"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <img src="/logo.svg" className="w-4 h-4 object-contain" alt="MailApp Logo" />
          <span className="text-zinc-400">{tr.app.name}</span>
        </div>
        <div className="flex items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            aria-label={isWindowMaximized ? "Asagi geri yukle" : "Ekrani kapla"}
            title={isWindowMaximized ? "Asagi geri yukle" : "Ekrani kapla"}
            onClick={async () => {
              const win = getCurrentWindow();
              await win.toggleMaximize();
              setIsWindowMaximized(await win.isMaximized());
            }}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            {isWindowMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            onClick={async () => { await getCurrentWindow().hide(); }}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-red-500/80 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          goToTab={goToTab}
          mobileMenuOpen={mobileMenuOpen}
          setMobileMenuOpen={setMobileMenuOpen}
          authStatus={authStatus}
          isUserSyncing={isUserSyncing}
          unreadCount={unreadCount}
          onLogin={loginWithGoogle}
          usesOverlaySidebar={usesOverlaySidebar}
          accounts={accounts}
          activeAccountId={activeAccountId}
          onSwitchAccount={handleSwitchAccount}
          onAddAccount={loginWithGoogle}
          onLogoutAccount={handleLogoutAccount}
          expiredAccountIds={expiredAccountIds}
        />

        {/* Compose FAB */}
        {accounts.length > 0 && (
          <div className="fixed bottom-6 right-6 z-50">
            <ToolbarTip label="Yeni e-posta">
              <button
                type="button"
                onClick={() => { setComposeAccountId(activeAccountId ?? accounts[0]?.id ?? null); setShowCompose(true); }}
                className="w-12 h-12 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/25 transition-all hover:scale-105 active:scale-95"
              >
                <Edit3 className="w-5 h-5" />
              </button>
            </ToolbarTip>
          </div>
        )}

        {showCompose && (
          <ComposeModal
            composeTo={composeTo} setComposeTo={setComposeTo}
            composeSubject={composeSubject} setComposeSubject={setComposeSubject}
            composeBody={composeBody} setComposeBody={setComposeBody}
            composeHtmlAppend={composeHtmlAppend}
            isSending={isSending}
            sendError={composeSendError}
            onSend={handleComposeSend}
            onClose={() => { setShowCompose(false); setComposeHtmlAppend(""); setComposeSendError(null); }}
            accounts={accounts}
            composeAccountId={composeAccountId}
            setComposeAccountId={setComposeAccountId}
          />
        )}

        <SettingsPanel
          isVisible={activeTab === "settings"}
          usesOverlaySidebar={usesOverlaySidebar}
          onMenuOpen={() => setMobileMenuOpen(open => !open)}
          themePreset={themePreset} setThemePreset={setThemePreset}
          densityMode={densityMode} setDensityMode={setDensityMode}
          syncIntervalValue={syncIntervalValue} setSyncIntervalValue={setSyncIntervalValue}
          launchAtStartup={launchAtStartup}
          startupSettingLoading={startupSettingLoading}
          onLaunchAtStartupChange={handleLaunchAtStartupChange}
          appControls={appControls} onUpdateAppControls={updateAppControls}
          notifDuration={notifDuration} setNotifDuration={setNotifDuration}
          notifInfinite={notifInfinite} setNotifInfinite={setNotifInfinite}
          lazyBodyLoading={lazyBodyLoading} setLazyBodyLoading={setLazyBodyLoading}
          renderMode={renderMode} setRenderMode={setRenderMode}
          remoteImageMode={remoteImageMode} setRemoteImageMode={setRemoteImageMode}
          otpMode={otpMode} setOtpMode={setOtpMode}
          appLanguage={appLanguage} setAppLanguage={handleAppLanguageChange}
          pauseOnFullscreen={pauseOnFullscreen} setPauseOnFullscreen={setPauseOnFullscreen}
          onResetLocalMailbox={resetLocalMailbox}
          isResettingLocalMailbox={isResettingLocalMailbox}
          currentVersion={currentVersion}
          isCheckingUpdate={isCheckingUpdate}
          updateAvailable={updateAvailable}
          updateProgress={updateProgress}
          updateError={updateError}
          updateStatus={updateStatus}
          onCheckForUpdates={checkForUpdates}
          onInstallUpdate={installUpdate}
          accounts={accounts}
          onAddAccount={loginWithGoogle}
          onLogoutAccount={handleLogoutAccount}
          onReorderAccounts={handleReorderAccounts}
        />

        {activeTab !== "settings" && (
          <>
            <EmailList
              className={mailListClassName}
              threadGroups={threadGroups}
              selectedMail={selectedMail}
              onMailClick={handleMailClick}
              isUserSyncing={isUserSyncing}
              isBackgroundSyncing={isBackgroundSyncing}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchInputRef={searchInputRef}
              activeTab={activeTab}
              usesOverlaySidebar={usesOverlaySidebar}
              onMenuOpen={() => setMobileMenuOpen(open => !open)}
              mailViewPreference={mailViewPreference}
              onViewPreferenceChange={handleMailViewPreferenceChange}
              onRefresh={handleRefresh}
              onLoadMore={loadOlderEmails}
              hasMoreEmails={hasSearchQuery ? false : hasMoreEmails}
              isLoadingMoreEmails={isLoadingMoreEmails}
              mailAppendVersion={mailAppendVersion}
              notificationFocusVersion={notificationFocusVersion}
              isMailboxBackfilling={isMailboxBackfilling}
              mailboxDownloadPending={mailboxDownloadPending}
              mailboxDownloadState={mailboxDownloadState}
              accessToken={accessToken}
              accounts={accounts}
              activeAccountId={activeAccountId}
            />
            {activeMail ? (
              <EmailReader
                className={mailReaderClassName}
                activeMail={activeMail}
                activeMailBody={selectedMailBody}
                isBodyLoading={isBodyLoading}
                bodyError={bodyError}
                hasLoadedActiveBody={hasLoadedActiveBody}
                mailViewMode={mailViewMode}
                activeTab={activeMailTab}
                closeReader={closeReader}
                showReply={showReply} setShowReply={setShowReply}
                replyMode={replyMode} setReplyMode={setReplyMode}
                replyText={replyText} setReplyText={setReplyText}
                isSending={isSending}
                onSendReply={handleReply}
                mailZoom={mailZoom}
                setMailFitScale={setMailFitScale}
                stepMailZoom={stepMailZoom}
                persistMailZoom={persistMailZoom}
                effectiveZoomPct={effectiveZoomPct}
                readingToolsOpen={readingToolsOpen} setReadingToolsOpen={setReadingToolsOpen}
                renderMode={renderMode} setRenderMode={setRenderMode}
                remoteImagesAllowedForEmail={canLoadRemoteImages}
                onLoadRemoteImages={handleLoadRemoteImages}
                onTrustRemoteImages={handleTrustRemoteImages}
                verificationCode={verificationCode}
                verificationCopyState={verificationCopyState}
                setVerificationCopyState={setVerificationCopyState}
                showArchiveBtn={showArchiveBtn}
                showRestoreBtn={showRestoreBtn}
                showTrashToBinBtn={showTrashToBinBtn}
                showDeleteForeverBtn={showDeleteForeverBtn}
                onArchive={() => handleArchive(activeMail)}
                onTrash={() => handleTrash(activeMail)}
                onMoveToInbox={() => handleMoveToInbox(activeMail)}
                onPermanentDelete={() => handlePermanentDelete(activeMail)}
                onMarkAsUnread={() => handleMarkAsUnread(activeMail)}
                onForward={() => handleForward(activeMail)}
                onOpenUrl={openExternalMailUrl}
                mailScrollRef={mailScrollRef}
                relayoutKey={`${mailViewMode}|${singlePanelView}|${windowWidth}`}
                threadEmails={threadEmails}
                accessToken={getTokenForEmail(activeMail) ?? null}
                showToast={showToast}
              />
            ) : (
              <main
                className={`${mailViewMode === "split" ? "hidden md:flex" : "hidden"} flex-1 items-center justify-center bg-[#0a0a0c]`}
              >
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                    <Inbox className="w-7 h-7 text-zinc-700" />
                  </div>
                  <h3 className="text-zinc-500 font-medium text-sm">{tr.mail.noSelection}</h3>
                  <p className="text-xs text-zinc-700 mt-1">{tr.mail.noSelectionHint}</p>
                </div>
              </main>
            )}
          </>
        )}
      </div>

      {/* Token expired banner */}
      {tokenExpired && (
        <div className="absolute top-9 left-0 right-0 bg-red-500/90 backdrop-blur-sm px-4 py-2 flex items-center justify-between z-50">
          <div className="flex items-center gap-2 text-white text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5" />
            {accounts.length > 1
              ? `${[...expiredAccountIds].map(id => accounts.find(a => a.id === id)?.email ?? id).join(", ")} session expired — signing in to any account will refresh it`
              : AUTH_RELOGIN_MESSAGE}
          </div>
          <button
            onClick={loginWithGoogle}
            className="px-3 py-1 bg-white text-red-600 text-xs font-semibold rounded hover:bg-red-50 transition-colors"
          >
            Sign In
          </button>
        </div>
      )}

      <ConfirmModal modal={confirmModal} onClose={() => setConfirmModal(null)} />

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium backdrop-blur-md animate-[slideIn_0.3s_ease] ${
              toast.type === "error"
                ? "bg-red-500/90 text-white"
                : toast.type === "success"
                ? "bg-emerald-500/90 text-white"
                : "bg-zinc-800/90 text-zinc-200 border border-white/10"
            }`}
          >
            {toast.type === "error" && <XCircle className="w-3.5 h-3.5 shrink-0" />}
            {toast.type === "success" && <CheckCircle className="w-3.5 h-3.5 shrink-0" />}
            <span className="flex-1 min-w-0 break-words">{toast.msg}</span>
          </div>
        ))}
      </div>
    </div>
    </LocaleContext.Provider>
  );
}

export default App;

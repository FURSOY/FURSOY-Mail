import { useState, useEffect, useRef, useCallback, useTransition } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Minus, Square, Copy, X, Edit3, Menu, Inbox, AlertTriangle, CheckCircle, XCircle,
} from "lucide-react";
import { LocaleContext, locales, type AppLanguage } from "./i18n";
import { surfaces, themePresets, type ThemePresetName } from "./theme";
import "./index.css";

import {
  type EmailSummary, type ThreadGroup, type AppControls, type OtpMode, type RenderMode,
  type MailZoom, type DensityMode, type MailViewMode, type MailViewPreference,
  type RemoteImageMode, DEFAULT_APP_CONTROLS,
} from "./types";
import { useMemo } from "react";
import {
  MAIL_TABS, STARTUP_NETWORK_DELAY_MS,
  MAX_LABEL_CACHE, MAIL_PAGE_SIZE, ZOOM_STEPS,
  isAuthFailure, extractVerificationCode,
  readMailZoom, readThemePreset, getAutoMailViewMode, parseMailtoUrl,
} from "./utils";

import { Sidebar } from "./components/Sidebar";
import { Onboarding } from "./components/Onboarding";
import { EmailList } from "./components/EmailList";
import { EmailReader } from "./components/EmailReader";
import { SettingsPanel } from "./components/SettingsPanel";
import { ComposeModal } from "./components/ComposeModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { ToolbarTip } from "./components/ToolbarTip";
import { useUpdater } from "./hooks/useUpdater";
import { useAccounts } from "./hooks/useAccounts";
import { useMailSync } from "./hooks/useMailSync";
import { useMailActions } from "./hooks/useMailActions";
import { useMailReader } from "./hooks/useMailReader";
import { tauriApi, type MailboxDownloadStatus } from "./tauriApi";

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

function App() {
  const [activeTab, setActiveTab] = useState<"inbox" | "sent" | "archive" | "spam" | "trash" | "settings">("inbox");
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("");

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
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(DEFAULT_APP_CONTROLS.appLanguage);
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
  const {
    accounts, accountsLoaded, isConnecting, accountTokens, activeAccountId,
    tokenExpired, expiredAccountIds,
    accountsRef, accountTokensRef, activeAccountIdRef, expiredAccountsRef, tokenExpiredRef,
    setIsConnecting, selectAccount, upsertToken, clearExpiredAccount, expireAccount, setSessionExpired,
    initializeAccounts, connectAccount, disconnectAccount, reorderAndReloadAccounts, refreshAccessToken,
  } = useAccounts();

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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [readingToolsOpen, setReadingToolsOpen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: "error" | "success" | "info" }[]>([]);
  const [verificationCopyState, setVerificationCopyState] = useState<"idle" | "copied">("idle");

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mailScrollRef = useRef<HTMLDivElement>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const syncChainIdRef = useRef(0);
  const recentNotificationsRef = useRef<Record<string, { accountId: string; messageId: string } | null>>({});
  const lastToastRef = useRef<{ msg: string; type: "error" | "success" | "info"; at: number } | null>(null);
  const previousAutoMailViewModeRef = useRef<MailViewMode | null>(null);
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
  const pauseOnFullscreenRef = useRef(pauseOnFullscreen);
  pauseOnFullscreenRef.current = pauseOnFullscreen;
  const appControlsRef = useRef(appControls);
  appControlsRef.current = appControls;

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
    root.style.setProperty("--app-accent-shadow", preset.accentShadow);
    root.dataset.density = densityMode;
  }, [themePreset, densityMode]);

  useEffect(() => {
    tauriApi.getLaunchAtStartup().then(setLaunchAtStartup).catch(console.error);
    tauriApi.getAppControls()
      .then((controls) => {
        const savedLanguage: AppLanguage = controls.appLanguage === "tr" ? "tr" : "en";
        const normalized: AppControls = { ...DEFAULT_APP_CONTROLS, ...controls, appLanguage: savedLanguage };
        setAppControls(normalized);
        setAppLanguage(savedLanguage);
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
    const { newlyExpired, allExpired } = expireAccount(accountId);
    if (!newlyExpired) return;

    // Per-account notification (only when single account expires, not via markSessionExpired)
    if (showMessage) {
      const email = accountsRef.current.find(a => a.id === accountId)?.email ?? accountId;
      showToast(tr.messages.accountSessionExpired.replace("{email}", email), "error");
    }

    // All accounts expired → banner + stop sync
    if (allExpired && !tokenExpiredRef.current) {
      setSessionExpired(true);
      setIsUserSyncing(false);
      setIsBackgroundSyncing(false);
      syncChainIdRef.current++;
      if (syncIntervalRef.current !== null) {
        clearTimeout(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    }
  }, [expireAccount, setSessionExpired, showToast, tokenExpiredRef, tr]);

  // backward-compat alias used in a few places
  const markSessionExpired = useCallback((showMessage = true) => {
    accountsRef.current.forEach(a => markAccountExpired(a.id, false));
    if (showMessage) showToast(tr.messages.reloginRequired, "error");
  }, [markAccountExpired, showToast, tr]);

  const shouldDeferNetworkForGameMode = useCallback(async (userInitiated = false) => {
    if (userInitiated || !pauseOnFullscreenRef.current) return false;
    try {
      return await tauriApi.isSystemFullscreen();
    } catch (e) {
      console.error("Fullscreen check failed:", e);
      return false;
    }
  }, []);

  const {
    currentVersion,
    isCheckingUpdate,
    updateAvailable,
    updateProgress,
    updateError,
    updateStatus,
    checkForUpdates,
    installUpdate,
  } = useUpdater({
    locale: tr,
    showToast,
    shouldDeferNetwork: shouldDeferNetworkForGameMode,
  });

  useEffect(() => {
    const openNotificationMail = async (messageId: string, accountId?: string) => {
      if (!messageId || !accountId) return;
      if (accountId && accountId !== activeAccountIdRef.current) {
        selectAccount(accountId);
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
      const result = await tauriApi.getEmailsByLabel({
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
      const status = await tauriApi.getMailboxDownloadStatus(accountId)
        .catch(() => ({ running: false, pending: false, state: "completed" as const, retryAfter: null }));
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
            .map(target => tauriApi.syncEmails(target.id, target.token, true))
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
          await tauriApi.resetLocalMailCache(null);
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
      const actual = await tauriApi.setLaunchAtStartup(checked);
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
      const saved = await tauriApi.setAppControls(merged);
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...saved });
    } catch (e) {
      console.error("Failed to update app controls:", e);
      setAppControls(previous);
      showToast(`${tr.messages.settingSaveFailed}: ${e}`, "error");
    }
  };

  const {
    isUserSyncing,
    isBackgroundSyncing,
    inboxUnread,
    setIsUserSyncing,
    setIsBackgroundSyncing,
    adjustUnreadBadge,
    refreshUnreadCount,
    clearPeriodicSync,
    startPeriodicSync,
  } = useMailSync({
    accountsRef,
    accountTokensRef,
    activeAccountIdRef,
    expiredAccountsRef,
    tokenExpiredRef,
    appControlsRef,
    activeTabRef,
    syncIntervalRef,
    syncChainIdRef,
    backgroundSyncRef,
    recentNotificationsRef,
    knownEmailIdsRef,
    notificationReadyAccountIdsRef,
    notificationBaselineEpochRef,
    pendingUnreadBadgeDeltasRef,
    emailsLength: emails.length,
    syncIntervalSeconds: syncIntervalValue,
    notificationDuration: notifDuration,
    notificationInfinite: notifInfinite,
    otpMode,
    appLanguage,
    locale: tr,
    loadEmails: () => loadEmails(),
    shouldDeferNetwork: shouldDeferNetworkForGameMode,
    refreshAccessToken,
    upsertToken,
    clearExpiredAccount,
    setSessionExpired,
    markAccountExpired,
    markSessionExpired,
    showToast,
  });

  const openExternalMailUrlRef = useRef<(url: string) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let startupSyncTimer: number | null = null;

    refreshUnreadCount();

    // Multi-account startup: load all accounts and their tokens
    initializeAccounts()
      .then(async (loadedAccounts) => {
        if (loadedAccounts.length === 0) return;

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
                  const refreshed = await refreshAccessToken(acc.id);
                  if (cancelled) return;
                  upsertToken(acc.id, refreshed.access_token);
                  clearExpiredAccount(acc.id);
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
        openExternalMailUrlRef.current(e.data.url);
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
  }, [shouldDeferNetworkForGameMode, markSessionExpired]);

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
      const status = await tauriApi.getMailboxDownloadStatus(accountId)
        .catch(() => ({ running: false, pending: false, state: "completed" as const, retryAfter: null }));
      if (!cancelled && isMailContextCurrent(label, accountId)) {
        setIsMailboxBackfilling(status.running);
        setMailboxDownloadPending(status.pending);
        setMailboxDownloadState(status.state);
        if (!status.running && !status.pending && MAIL_TABS.has(label)) {
          const cursor = mailPageCursorRef.current;
          const nextPage = await tauriApi.getEmailsByLabel({
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
      void tauriApi.searchLocalEmails(query, accountId, 500)
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
      tauriApi.getLaunchAtStartup().then(setLaunchAtStartup).catch(console.error);
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
      await connectAccount();

      setAuthStatus(tr.auth.loggedInSyncing);
      const stillExpired = expiredAccountsRef.current.size > 0;
      setSessionExpired(stillExpired);
      // The first download for a newly added account is a baseline, not new-mail activity.
      const ok = await backgroundSyncRef.current({ userInitiated: true, suppressNotifications: true });
      if (ok) {
        setAuthStatus(tr.auth.syncComplete);
        showToast(tr.auth.loginSuccess, "success");
      } else {
        setAuthStatus(tr.auth.syncFailedAfterLogin);
      }
      startPeriodicSync();
    } catch (e) {
      setAuthStatus(`${tr.auth.loginFailed}: ${e}`);
      setIsUserSyncing(false);
      showToast(`${tr.auth.loginFailed}: ${e}`, "error");
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleLogoutAccount(accountId: string) {
    try {
      notificationReadyAccountIdsRef.current.delete(accountId);
      const removedAccountPrefix = `${accountId}\u0000`;
      knownEmailIdsRef.current = new Set(
        [...knownEmailIdsRef.current].filter(key => !key.startsWith(removedAccountPrefix))
      );

      const updatedAccounts = await disconnectAccount(accountId);

      if (updatedAccounts.length === 0) {
        clearPeriodicSync();
        setSessionExpired(false);
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
      showToast(tr.auth.loggedOut, "success");
    } catch (e) {
      console.error("Logout failed:", e);
      showToast(`${tr.messages.signOutFailed}: ${e}`, "error");
    }
  }

  async function handleReorderAccounts(orderedIds: string[]) {
    try {
      await reorderAndReloadAccounts(orderedIds);
    } catch (e) {
      console.error("Reorder failed:", e);
    }
  }

  async function handleSwitchAccount(accountId: string | null) {
    selectAccount(accountId);
    tabEmailCacheRef.current = {};
    resetMailPagination();
    setSelectedMail(null);
    await loadEmails(activeTabRef.current);
    await refreshUnreadCount();
  }

  const handleRefresh = async () => {
    if (Object.keys(accountTokensRef.current).length === 0) {
      showToast(tr.messages.pleaseSignIn, "error");
      return;
    }
    setAuthStatus(tr.messages.syncing);
    const ok = await backgroundSyncRef.current({ userInitiated: true });
    if (ok) {
      setAuthStatus(tr.messages.upToDate);
      showToast(tr.messages.inboxUpdated, "success");
    } else {
      setAuthStatus(tr.messages.refreshFailed);
      showToast(tr.mail.syncFailed, "error");
      const status = await tauriApi.getMailboxDownloadStatus(activeAccountIdRef.current).catch(() => null);
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
        await tauriApi.markAsRead(mail.account_id, getTokenForEmail(mail), mail.id);
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

  const handleAppLanguageChange = async (language: AppLanguage) => {
    const previous = appLanguage;
    setAppLanguage(language);
    try {
      const saved = await tauriApi.setAppLanguage(language);
      const savedLanguage: AppLanguage = saved.appLanguage === "tr" ? "tr" : "en";
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...saved, appLanguage: savedLanguage });
      setAppLanguage(savedLanguage);
    } catch (error) {
      console.error("Failed to save app language:", error);
      setAppLanguage(previous);
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

  const {
    selectedMailBody,
    setSelectedMailBody,
    selectedMailBodyId,
    setSelectedMailBodyId,
    isBodyLoading,
    bodyError,
    threadEmails,
    setThreadEmails,
    setThreadRefreshKey,
  } = useMailReader({
    selectedMail,
    activeMail,
    activeMailKey,
    locale: tr,
    mailScrollRef,
    recentlyReadRef,
    setEmails,
    setSearchResults,
    setReadingToolsOpen,
    getTokenForEmail,
    adjustUnreadBadge,
  });

  const {
    showReply, setShowReply, replyMode, setReplyMode, replyText, setReplyText,
    isSending, showCompose, setShowCompose, confirmModal, setConfirmModal,
    composeTo, setComposeTo, composeSubject, setComposeSubject, composeBody, setComposeBody,
    composeHtmlAppend, setComposeHtmlAppend, composeAccountId, setComposeAccountId,
    composeSendError, setComposeSendError,
    handleArchive, handleTrash, handleMoveToInbox, handlePermanentDelete,
    handleReply, handleComposeSend, handleMarkAsUnread, handleForward,
  } = useMailActions({
    locale: tr,
    accounts,
    accountTokens,
    activeAccountId,
    activeMail,
    selectedMailBody,
    activeTabRef,
    recentlyReadRef,
    setEmails,
    setSelectedMail,
    setThreadRefreshKey,
    getTokenForEmail,
    loadEmails,
    refreshUnreadCount,
    adjustUnreadBadge,
    refreshAccessToken,
    upsertToken,
    clearExpiredAccount,
    markAccountExpired,
    showToast,
  });

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

    const mailto = parseMailtoUrl(normalized);
    if (mailto) {
      setComposeTo(mailto.to);
      setComposeSubject(mailto.subject);
      setComposeBody(mailto.body);
      setComposeHtmlAppend("");
      setComposeSendError(null);
      setComposeAccountId(activeAccountId ?? accounts[0]?.id ?? null);
      setShowCompose(true);
      return;
    }

    openUrl(normalized).catch((err) => {
      console.error("Failed to open mail link:", err);
      showToast(tr.actions.openLinkFailed, "error");
    });
  }, [
    accounts, activeAccountId, setComposeAccountId, setComposeBody,
    setComposeHtmlAppend, setComposeSendError, setComposeSubject,
    setComposeTo, setShowCompose, showToast, tr,
  ]);
  openExternalMailUrlRef.current = openExternalMailUrl;

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

  useEffect(() => { setVerificationCopyState("idle"); }, [selectedMail]);
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
      ? `flex min-w-0 flex-col border-r border-[var(--color-border-subtle)] ${surfaces.app} ${selectedMail ? "hidden md:flex md:w-80 lg:w-96" : "flex-1 md:w-80 lg:w-96 md:flex-none"}`
      : showMailList
      ? `flex min-w-0 flex-1 flex-col border-r border-[var(--color-border-subtle)] ${surfaces.app}`
      : "hidden";
  const mailReaderClassName = showMailReader
    ? `flex-1 min-w-0 flex flex-col ${surfaces.content} relative z-10 select-text`
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
    return (
      <LocaleContext.Provider value={tr}>
        <Onboarding onConnect={loginWithGoogle} isConnecting={isConnecting} />
      </LocaleContext.Provider>
    );
  }

  return (
    <LocaleContext.Provider value={tr}>
    <div className={`flex flex-col h-screen ${surfaces.app} text-[var(--color-text-secondary)] font-sans overflow-hidden select-none`}>
      {/* CUSTOM TITLEBAR */}
      <div
        data-tauri-drag-region
        className={`relative z-[60] h-9 shrink-0 flex items-center justify-between pl-2 pr-0 border-b border-[var(--color-border-subtle)] ${surfaces.app}`}
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
            aria-label={tr.common.openMenu}
          >
            <Menu className="h-4 w-4" />
          </button>
          <img src="/logo.svg" className="w-4 h-4 object-contain" alt={tr.app.name} />
          <span className="text-zinc-400">{tr.app.name}</span>
        </div>
        <div className="flex items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            aria-label={tr.common.minimize}
            title={tr.common.minimize}
            onClick={() => getCurrentWindow().minimize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            aria-label={isWindowMaximized ? tr.common.restore : tr.common.maximize}
            title={isWindowMaximized ? tr.common.restore : tr.common.maximize}
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
            aria-label={tr.common.close}
            title={tr.common.close}
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
            <ToolbarTip label={tr.actions.newEmail}>
              <button
                type="button"
                onClick={() => { setComposeAccountId(activeAccountId ?? accounts[0]?.id ?? null); setShowCompose(true); }}
                className="w-12 h-12 rounded-full bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--color-text-on-accent)] flex items-center justify-center shadow-[var(--shadow-accent-lg)] transition-all hover:scale-105 active:scale-95"
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
                className={`${mailViewMode === "split" ? "hidden md:flex" : "hidden"} flex-1 items-center justify-center ${surfaces.content}`}
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
              ? tr.messages.multipleSessionsExpired.replace(
                  "{emails}",
                  [...expiredAccountIds].map(id => accounts.find(a => a.id === id)?.email ?? id).join(", "),
                )
              : tr.messages.reloginRequired}
          </div>
          <button
            onClick={loginWithGoogle}
            className="px-3 py-1 bg-white text-red-600 text-xs font-semibold rounded hover:bg-red-50 transition-colors"
          >
            {tr.messages.signIn}
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

import { Inbox, Send, Archive, ShieldAlert, Trash2, Settings, LogOut, RefreshCw } from "lucide-react";
import { tr } from "../i18n";
import type { AuthInfo } from "../types";
import { ToolbarTip } from "./ToolbarTip";

type TabName = "inbox" | "sent" | "archive" | "spam" | "trash" | "settings";

interface SidebarProps {
  activeTab: string;
  goToTab: (tab: TabName) => void;
  userInfo: AuthInfo | null;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  authStatus: string;
  isUserSyncing: boolean;
  unreadCount: number;
  onLogout: () => void;
  onLogin: () => void;
  usesOverlaySidebar: boolean;
}

export function Sidebar({
  activeTab, goToTab, userInfo, mobileMenuOpen, setMobileMenuOpen,
  authStatus, isUserSyncing, unreadCount, onLogout, onLogin, usesOverlaySidebar,
}: SidebarProps) {
  const backdropCls = `fixed inset-x-0 bottom-0 top-9 z-40 bg-black/55 transition-opacity duration-200 ${
    usesOverlaySidebar && mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
  }`;
  const asideCls = usesOverlaySidebar
    ? `fixed left-0 top-9 bottom-0 z-50 flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e]/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-200 ease-out ${mobileMenuOpen ? "translate-x-0" : "-translate-x-full pointer-events-none"}`
    : "static z-auto flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e] shadow-none";

  const navItem = (tab: TabName, icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <button
      onClick={() => goToTab(tab)}
      className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
        activeTab === tab
          ? "bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]"
          : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      }`}
    >
      {icon}
      {label}
      {badge}
    </button>
  );

  return (
    <>
      <div className={backdropCls} onClick={() => setMobileMenuOpen(false)} aria-hidden={!mobileMenuOpen} />
      <aside className={asideCls}>
        <nav className="flex-1 p-2 pt-3 space-y-0.5">
          {navItem(
            "inbox",
            <Inbox className="w-4 h-4" />,
            tr.nav.inbox,
            unreadCount > 0 ? (
              <span className="ml-auto text-[10px] bg-blue-500 text-white min-w-[18px] text-center py-0.5 px-1 rounded-full font-bold">
                {unreadCount}
              </span>
            ) : undefined
          )}
          {navItem("sent", <Send className="w-4 h-4" />, tr.nav.sent)}
          {navItem("archive", <Archive className="w-4 h-4" />, tr.nav.archive)}

          <div className="my-2 border-t border-white/5" />

          {navItem("spam", <ShieldAlert className="w-4 h-4" />, tr.nav.spam)}
          {navItem("trash", <Trash2 className="w-4 h-4" />, tr.nav.trash)}

          <div className="my-2 border-t border-white/5" />

          {navItem("settings", <Settings className="w-4 h-4" />, tr.nav.settings)}
        </nav>

        <div className="p-2 mt-auto">
          {userInfo ? (
            <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5 relative group">
              <img
                src={userInfo.picture}
                alt="Profile"
                className="w-7 h-7 rounded-full bg-zinc-800 object-cover shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-zinc-300 truncate">{userInfo.email.split("@")[0]}</div>
                <div className="text-[10px] text-zinc-600 truncate">{userInfo.email}</div>
              </div>
              <ToolbarTip label="Çıkış">
                <button
                  type="button"
                  onClick={onLogout}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-red-400 transition-all"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </ToolbarTip>
            </div>
          ) : (
            <>
              <div className="px-2 py-1 text-[10px] text-zinc-600">{authStatus}</div>
              <button
                onClick={onLogin}
                disabled={isUserSyncing}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                <Settings className="w-4 h-4" />
                {tr.auth.loginWithGoogle}
                {isUserSyncing && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 ml-auto" />}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

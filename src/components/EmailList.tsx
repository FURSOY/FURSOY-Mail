import { Search, X, RefreshCw, Settings, Columns2, PanelLeft, Rows3, Menu } from "lucide-react";
import { tr } from "../i18n";
import type { EmailSummary, MailViewPreference } from "../types";
import { formatDate } from "../utils";
import { ToolbarTip } from "./ToolbarTip";

interface EmailListProps {
  className: string;
  displayEmails: EmailSummary[];
  selectedMail: string | null;
  onMailClick: (mail: EmailSummary) => void;
  isUserSyncing: boolean;
  isBackgroundSyncing: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  activeTab: string;
  usesOverlaySidebar: boolean;
  onMenuOpen: () => void;
  mailViewPreference: MailViewPreference;
  onViewPreferenceChange: (mode: MailViewPreference) => void;
  onRefresh: () => void;
  accessToken: string | null;
}

export function EmailList({
  className, displayEmails, selectedMail, onMailClick,
  isUserSyncing, isBackgroundSyncing,
  searchQuery, setSearchQuery, searchInputRef,
  activeTab, usesOverlaySidebar, onMenuOpen,
  mailViewPreference, onViewPreferenceChange,
  onRefresh, accessToken,
}: EmailListProps) {
  return (
    <section className={className}>
      <div className="h-12 flex items-center px-4 border-b border-white/5 justify-between shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {usesOverlaySidebar && (
            <button
              type="button"
              onClick={onMenuOpen}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
              aria-label="Menuyu ac"
              title="Menuyu ac"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          <h2 className="min-w-0 truncate font-semibold text-zinc-100 text-sm capitalize" title={activeTab}>
            {activeTab}
          </h2>
          {isUserSyncing && (
            <span className="text-[10px] uppercase tracking-wider text-blue-500 font-semibold animate-pulse">
              Senkronize…
            </span>
          )}
          {isBackgroundSyncing && !isUserSyncing && (
            <span className="text-[10px] text-zinc-600 font-medium">Arka planda güncelleniyor</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="inline-flex rounded-md border border-white/10 bg-white/[0.03] p-0.5">
            {(
              [
                ["auto", Settings, "Otomatik"],
                ["split", Columns2, "Yan yana"],
                ["single-toggle", PanelLeft, "Dar menu"],
                ["inbox-first", Rows3, "Liste odakli"],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onViewPreferenceChange(mode)}
                className={`flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors ${
                  mailViewPreference === mode
                    ? "bg-white/10 text-zinc-100"
                    : "hover:bg-white/5 hover:text-zinc-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <ToolbarTip label="Gelen kutusunu sunucudan yenile">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isUserSyncing || !accessToken}
              className="p-1.5 rounded-md hover:bg-white/10 text-zinc-500 transition-all disabled:opacity-20"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isUserSyncing ? "animate-spin text-blue-500" : ""}`} />
            </button>
          </ToolbarTip>
        </div>
      </div>

      {/* Search Bar */}
      <div className="p-2 border-b border-white/5">
        <div className="relative group">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-blue-500 transition-colors" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search emails... (Ctrl+K)"
            className="w-full bg-white/[0.03] border border-white/5 rounded-lg pl-8 pr-7 py-1.5 text-xs outline-none focus:border-blue-500/40 focus:bg-white/[0.02] transition-colors text-zinc-200 placeholder:text-zinc-600 select-text"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300 rounded hover:bg-white/10 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {displayEmails.length === 0 && !isUserSyncing && !isBackgroundSyncing && (
          <div className="p-8 text-center text-zinc-600 text-xs">
            {searchQuery
              ? tr.mail.searchEmpty
              : activeTab === "inbox"
              ? tr.mail.emptyInbox
              : tr.mail.emptyFolder}
          </div>
        )}
        {displayEmails.map((mail) => (
          <div
            key={mail.id}
            onClick={() => onMailClick(mail)}
            className={`px-4 py-[var(--mail-row-py)] border-b border-white/[0.03] cursor-pointer transition-all duration-200 relative ${
              selectedMail === mail.id
                ? "bg-[var(--app-accent-soft)] border-l-2 border-l-[var(--app-accent)]"
                : "hover:bg-white/[0.02] border-l-2 border-l-transparent"
            }`}
          >
            {mail.unread && (
              <div className="absolute left-1 top-4 w-1.5 h-1.5 rounded-full bg-blue-500" />
            )}
            <div className="flex justify-between items-baseline mb-0.5 gap-2 min-w-0">
              <span
                className={`min-w-0 truncate text-xs ${mail.unread ? "font-semibold text-zinc-100" : "text-zinc-400"}`}
                title={mail.label === "sent" ? mail.recipient : mail.sender}
              >
                {mail.label === "sent"
                  ? `To: ${(mail.recipient || "").split("<")[0].replace(/"/g, "").trim() || mail.recipient}`
                  : mail.sender.split("<")[0].replace(/"/g, "").trim()}
              </span>
              <span className="text-[10px] text-zinc-600 shrink-0">{formatDate(mail.date)}</span>
            </div>
            <h3
              className={`min-w-0 truncate text-xs ${mail.unread ? "text-zinc-200 font-medium" : "text-zinc-500"}`}
              title={mail.subject}
            >
              {mail.subject}
            </h3>
            <p className="mt-0.5 min-w-0 truncate text-[11px] text-zinc-600" title={mail.snippet}>
              {mail.snippet}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

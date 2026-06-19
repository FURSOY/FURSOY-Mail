import { useRef, type CSSProperties } from "react";
import {
  CornerUpLeft, Inbox, Send, Archive, ShieldAlert, Trash2,
  Users, Forward, Eye, RotateCcw, Minus, Plus, Maximize2,
  Settings, X, RefreshCw, Copy,
} from "lucide-react";
import { tr } from "../i18n";
import type { EmailSummary, MailViewMode, MailZoom, RenderMode } from "../types";
import { formatDateFull } from "../utils";
import { EmailHtmlView } from "./EmailHtmlView";
import { ToolbarTip } from "./ToolbarTip";

interface EmailReaderProps {
  className: string;
  activeMail: EmailSummary;
  activeMailHtml: string;
  isBodyLoading: boolean;
  bodyError: string | null;
  hasLoadedActiveBody: boolean;
  mailViewMode: MailViewMode;
  activeTab: string;
  closeReader: () => void;

  showReply: boolean;
  setShowReply: (v: boolean) => void;
  replyMode: "reply" | "reply-all";
  setReplyMode: (v: "reply" | "reply-all") => void;
  replyText: string;
  setReplyText: (v: string) => void;
  isSending: boolean;
  onSendReply: () => void;

  mailZoom: MailZoom;
  setMailFitScale: (scale: number) => void;
  stepMailZoom: (dir: 1 | -1) => void;
  persistMailZoom: (zoom: MailZoom) => void;
  effectiveZoomPct: number;

  readingToolsOpen: boolean;
  setReadingToolsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  renderMode: RenderMode;
  setRenderMode: (v: RenderMode) => void;

  verificationCode: string | null;
  verificationCopyState: "idle" | "copied";
  setVerificationCopyState: (v: "idle" | "copied") => void;

  showArchiveBtn: boolean;
  showRestoreBtn: boolean;
  showTrashToBinBtn: boolean;
  showDeleteForeverBtn: boolean;

  onArchive: () => void;
  onTrash: () => void;
  onMoveToInbox: () => void;
  onPermanentDelete: () => void;
  onMarkAsUnread: () => void;
  onForward: () => void;
  onOpenUrl: (url: string) => void;
  mailScrollRef: React.RefObject<HTMLDivElement | null>;
  relayoutKey: string;
}

export function EmailReader({
  className, activeMail, activeMailHtml,
  isBodyLoading, bodyError, hasLoadedActiveBody,
  mailViewMode, activeTab, closeReader,
  showReply, setShowReply, replyMode, setReplyMode, replyText, setReplyText,
  isSending, onSendReply,
  mailZoom, setMailFitScale, stepMailZoom, persistMailZoom, effectiveZoomPct,
  readingToolsOpen, setReadingToolsOpen, renderMode, setRenderMode,
  verificationCode, verificationCopyState, setVerificationCopyState,
  showArchiveBtn, showRestoreBtn, showTrashToBinBtn, showDeleteForeverBtn,
  onArchive, onTrash, onMoveToInbox, onPermanentDelete, onMarkAsUnread, onForward,
  onOpenUrl, mailScrollRef, relayoutKey,
}: EmailReaderProps) {
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const openReply = (mode: "reply" | "reply-all") => {
    setReplyMode(mode);
    setShowReply(true);
    setTimeout(() => replyRef.current?.focus(), 100);
  };

  return (
    <main className={className}>
      {/* Mobile Back Button */}
      <div className="md:hidden h-12 flex items-center px-4 border-b border-white/5 shrink-0">
        <button
          onClick={closeReader}
          className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <CornerUpLeft className="w-3.5 h-3.5" /> Back
        </button>
      </div>

      {/* Desktop Toolbar */}
      <div className="hidden md:flex h-12 items-center justify-between gap-2 px-3 lg:px-5 border-b border-white/5 shrink-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {mailViewMode !== "split" && (
            <button
              type="button"
              onClick={closeReader}
              className="mr-1 shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              aria-label="Listeye don"
              title="Listeye don"
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="min-w-0 truncate text-xs text-zinc-500 flex items-center gap-1.5 capitalize">
            {activeTab === "inbox" && <Inbox className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "sent" && <Send className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "archive" && <Archive className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "spam" && <ShieldAlert className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "trash" && <Trash2 className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate">{activeTab}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <ToolbarTip label="Yanıtla">
            <button
              type="button"
              onClick={() => openReply("reply")}
              className={`p-2 rounded-md hover:bg-white/5 transition-colors ${
                showReply && replyMode === "reply" ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <CornerUpLeft className="w-4 h-4" />
            </button>
          </ToolbarTip>
          {activeMail.cc && (
            <ToolbarTip label="Tümünü yanıtla">
              <button
                type="button"
                onClick={() => openReply("reply-all")}
                className={`p-2 rounded-md hover:bg-white/5 transition-colors ${
                  showReply && replyMode === "reply-all" ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Users className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          <ToolbarTip label="İlet">
            <button
              type="button"
              onClick={onForward}
              className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <Forward className="w-4 h-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label="Okunmadı olarak işaretle">
            <button
              type="button"
              onClick={onMarkAsUnread}
              className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <Eye className="w-4 h-4" />
            </button>
          </ToolbarTip>
          {showRestoreBtn && (
            <ToolbarTip label={activeTab === "spam" ? "Spam değil (gelen kutusu)" : "Gelen kutusuna taşı"}>
              <button
                type="button"
                onClick={onMoveToInbox}
                className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-emerald-400 transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showArchiveBtn && (
            <ToolbarTip label="Arşivle">
              <button
                type="button"
                onClick={onArchive}
                className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-amber-400 transition-colors"
              >
                <Archive className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showTrashToBinBtn && (
            <ToolbarTip label="Çöpe taşı">
              <button
                type="button"
                onClick={onTrash}
                className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showDeleteForeverBtn && (
            <ToolbarTip label="Kalıcı olarak sil">
              <button
                type="button"
                onClick={onPermanentDelete}
                className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-500 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          <div className="mx-1 hidden h-5 w-px bg-white/5 lg:block" />
          <div className="hidden items-center rounded-md border border-white/10 bg-white/[0.03] lg:flex">
            <ToolbarTip label={tr.reading.zoomOut}>
              <button
                type="button"
                onClick={() => stepMailZoom(-1)}
                className="flex h-7 w-7 items-center justify-center rounded-l-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                aria-label={tr.reading.zoomOut}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </ToolbarTip>
            <ToolbarTip label={tr.reading.fitWidthHint}>
              <button
                type="button"
                onClick={() => persistMailZoom("fit")}
                className={`flex h-7 min-w-[3.25rem] items-center justify-center gap-1 px-1 text-[11px] font-medium tabular-nums transition-colors ${
                  mailZoom === "fit" ? "text-[var(--app-accent)]" : "text-zinc-300 hover:text-zinc-100"
                }`}
                aria-label={tr.reading.fitWidth}
              >
                {mailZoom === "fit" && <Maximize2 className="h-3 w-3" />}
                {effectiveZoomPct}%
              </button>
            </ToolbarTip>
            <ToolbarTip label={tr.reading.zoomIn}>
              <button
                type="button"
                onClick={() => stepMailZoom(1)}
                className="flex h-7 w-7 items-center justify-center rounded-r-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                aria-label={tr.reading.zoomIn}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </ToolbarTip>
          </div>
          <ToolbarTip label={tr.reading.settings}>
            <button
              type="button"
              onClick={() => setReadingToolsOpen(open => !open)}
              className={`p-2 rounded-md transition-colors ${
                readingToolsOpen
                  ? "bg-[var(--app-accent-soft)] text-zinc-100"
                  : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </ToolbarTip>
        </div>
      </div>

      {/* Reading Tools Panel */}
      <aside
        className={`absolute bottom-0 right-0 top-12 z-20 hidden w-72 border-l border-white/10 bg-[#0c0c0e]/95 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl transition-transform duration-200 md:block ${
          readingToolsOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!readingToolsOpen}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">{tr.reading.settings}</h3>
          <button
            type="button"
            onClick={() => setReadingToolsOpen(false)}
            className="rounded-md p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <div className="mb-1 text-sm text-zinc-300">{tr.reading.zoom}</div>
            <p className="mb-2 text-[11px] leading-relaxed text-zinc-600">{tr.reading.zoomHint}</p>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center rounded-lg border border-white/10 bg-[#09090b]">
                <button
                  type="button"
                  onClick={() => stepMailZoom(-1)}
                  className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                  aria-label={tr.reading.zoomOut}
                  title={tr.reading.zoomOut}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[3rem] text-center text-xs font-medium text-zinc-200 tabular-nums">
                  {effectiveZoomPct}%
                </span>
                <button
                  type="button"
                  onClick={() => stepMailZoom(1)}
                  className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                  aria-label={tr.reading.zoomIn}
                  title={tr.reading.zoomIn}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => persistMailZoom("fit")}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  mailZoom === "fit"
                    ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-zinc-100"
                    : "border-white/10 bg-[#09090b] text-zinc-400 hover:text-zinc-200"
                }`}
                title={tr.reading.fitWidthHint}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                {tr.reading.fitWidth}
              </button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-zinc-300">{tr.reading.renderMode}</div>
            <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
              <button
                type="button"
                onClick={() => {
                  setRenderMode("full");
                  localStorage.setItem("fursoy_render_mode", "full");
                }}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  renderMode === "full" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Tam HTML
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenderMode("simple");
                  localStorage.setItem("fursoy_render_mode", "simple");
                }}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  renderMode === "simple" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Basit
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Scrollable Content */}
      <div ref={mailScrollRef} className="flex-1 overflow-y-scroll overscroll-contain p-6 md:p-8">
        <div className="mx-auto w-full max-w-[1040px] min-w-0">
          <h1 className="text-xl font-bold text-zinc-100 mb-5">{activeMail.subject}</h1>

          {/* OTP Banner */}
          {verificationCode && (
            <div className="mb-4 flex items-center justify-between px-4 py-3 rounded-lg bg-blue-500/10 border border-blue-500/20 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <ShieldAlert className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <div className="text-[11px] text-blue-400/70 font-medium">Doğrulama Kodu</div>
                  <div className="text-lg font-bold text-blue-300 tracking-[0.3em] font-mono">{verificationCode}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(verificationCode);
                  setVerificationCopyState("copied");
                  window.setTimeout(() => setVerificationCopyState("idle"), 2000);
                }}
                className="min-w-[7.5rem] justify-center px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-semibold transition-colors flex items-center gap-2"
              >
                <Copy className="w-3.5 h-3.5" />
                {verificationCopyState === "copied" ? "Kopyalandı" : "Kopyala"}
              </button>
            </div>
          )}

          {/* Mail Header */}
          <div className="flex items-center justify-between mb-5 pb-5 border-b border-white/5 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[var(--app-accent)] flex items-center justify-center text-white text-sm font-bold shrink-0">
                {activeMail.sender.charAt(0).toUpperCase() || "U"}
              </div>
              <div>
                <div className="text-sm font-medium text-zinc-200">
                  {activeMail.sender.split("<")[0].replace(/"/g, "").trim()}
                </div>
                <div className="text-[11px] text-zinc-600 mt-0.5">
                  {activeTab === "sent" ? "from me" : "to me"} · {formatDateFull(activeMail.date)}
                </div>
                {activeMail.cc && (
                  <div className="text-[11px] text-zinc-600 mt-0.5">
                    <span className="text-zinc-700">CC:</span> {activeMail.cc}
                  </div>
                )}
              </div>
            </div>
            {/* Mobile action buttons */}
            <div className="flex md:hidden items-center gap-1">
              <ToolbarTip label="Yanıtla">
                <button
                  type="button"
                  onClick={() => setShowReply(!showReply)}
                  className="p-2 rounded-md hover:bg-white/5 text-zinc-400"
                >
                  <CornerUpLeft className="w-4 h-4" />
                </button>
              </ToolbarTip>
              {showRestoreBtn && (
                <ToolbarTip label={activeTab === "spam" ? "Spam değil" : "Gelen kutusu"}>
                  <button type="button" onClick={onMoveToInbox} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </ToolbarTip>
              )}
              {showArchiveBtn && (
                <ToolbarTip label="Arşivle">
                  <button type="button" onClick={onArchive} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                    <Archive className="w-4 h-4" />
                  </button>
                </ToolbarTip>
              )}
              {showTrashToBinBtn && (
                <ToolbarTip label="Çöpe taşı">
                  <button type="button" onClick={onTrash} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </ToolbarTip>
              )}
              {showDeleteForeverBtn && (
                <ToolbarTip label="Kalıcı sil">
                  <button type="button" onClick={onPermanentDelete} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </ToolbarTip>
              )}
            </div>
          </div>

          {/* Mail Content */}
          <div className="flex min-w-0 flex-col bg-white rounded-lg overflow-hidden border border-black/10">
            {isBodyLoading ? (
              <div className="flex min-h-[240px] items-center justify-center text-xs text-zinc-500">
                {tr.mail.loadingBody}
              </div>
            ) : bodyError ? (
              <div className="flex min-h-[240px] items-center justify-center text-xs text-red-400">
                {bodyError}
              </div>
            ) : hasLoadedActiveBody ? (
              <EmailHtmlView
                key={activeMail.id}
                html={activeMailHtml}
                zoom={mailZoom}
                relayoutKey={relayoutKey}
                onFitScaleChange={setMailFitScale}
                onOpenUrl={onOpenUrl}
                scrollRef={mailScrollRef}
              />
            ) : (
              <div className="flex min-h-[240px] items-center justify-center text-xs text-zinc-500">
                {tr.mail.preparingBody}
              </div>
            )}
          </div>

          {/* Reply Box */}
          {showReply && (
            <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
                {replyMode === "reply-all" ? (
                  <Users className="w-3.5 h-3.5 text-zinc-500" />
                ) : (
                  <CornerUpLeft className="w-3.5 h-3.5 text-zinc-500" />
                )}
                <span className="text-xs text-zinc-400 truncate">
                  {replyMode === "reply-all" ? (
                    <>
                      Tümüne yanıtla:{" "}
                      <span className="text-zinc-300">
                        {activeMail.sender.split("<")[0].replace(/"/g, "").trim()}
                        {activeMail.cc ? `, ${activeMail.cc}` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      {tr.mail.replyTo}{" "}
                      <span className="text-zinc-300">
                        {activeMail.sender.split("<")[0].replace(/"/g, "").trim()}
                      </span>
                    </>
                  )}
                </span>
              </div>
              <textarea
                ref={replyRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={tr.mail.writeReply}
                className="w-full bg-transparent p-4 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none resize-none min-h-[120px] select-text"
              />
              <div className="px-3 py-2 border-t border-white/[0.04] text-[11px] text-zinc-700 italic truncate">
                — {activeMail.sender.split("<")[0].replace(/"/g, "").trim()},{" "}
                {formatDateFull(activeMail.date)}
              </div>
              <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between">
                <button
                  onClick={() => { setShowReply(false); setReplyText(""); }}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {tr.mail.cancel}
                </button>
                <button
                  onClick={onSendReply}
                  disabled={!replyText.trim() || isSending}
                  className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-2"
                >
                  {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {isSending ? tr.compose.sending : tr.mail.sendReply}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

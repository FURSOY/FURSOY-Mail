import { X, RefreshCw, Send, ChevronDown, AlertCircle } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../i18n";
import { ui } from "../theme";
import type { Account } from "../types";

interface ContactSuggestion {
  name: string;
  email: string;
}

interface ComposeModalProps {
  composeTo: string;
  setComposeTo: (v: string) => void;
  composeSubject: string;
  setComposeSubject: (v: string) => void;
  composeBody: string;
  setComposeBody: (v: string) => void;
  composeHtmlAppend: string;
  isSending: boolean;
  sendError: string | null;
  onSend: () => void;
  onClose: () => void;
  accounts: Account[];
  composeAccountId: string | null;
  setComposeAccountId: (id: string) => void;
}

function emailColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = email.charCodeAt(i) + ((h << 5) - h);
  const palette = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#f97316"];
  return palette[Math.abs(h) % palette.length];
}

export function ComposeModal({
  composeTo, setComposeTo,
  composeSubject, setComposeSubject,
  composeBody, setComposeBody,
  composeHtmlAppend,
  isSending,
  sendError,
  onSend,
  onClose,
  accounts,
  composeAccountId,
  setComposeAccountId,
}: ComposeModalProps) {
  const [fromOpen, setFromOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggOpen, setSuggOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const fromRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const suggRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeAccount = accounts.find(a => a.id === composeAccountId) ?? accounts[0];

  // Close "from" dropdown on outside click
  useEffect(() => {
    if (!fromOpen) return;
    const h = (e: MouseEvent) => {
      if (fromRef.current && !fromRef.current.contains(e.target as Node)) setFromOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [fromOpen]);

  // Close suggestion dropdown on outside click
  useEffect(() => {
    if (!suggOpen) return;
    const h = (e: MouseEvent) => {
      if (toRef.current && !toRef.current.contains(e.target as Node) &&
          suggRef.current && !suggRef.current.contains(e.target as Node)) {
        setSuggOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [suggOpen]);

  // Search contacts with debounce
  const searchContacts = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = q.trim();
    if (trimmed.length < 1) { setSuggestions([]); setSuggOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await invoke<ContactSuggestion[]>("search_contacts", { query: trimmed });
        setSuggestions(res);
        setSuggOpen(res.length > 0);
        setHighlightIdx(0);
      } catch {
        // silently ignore
      }
    }, 200);
  }, []);

  const handleToChange = (v: string) => {
    setComposeTo(v);
    // search based on the token being typed (after last comma)
    const token = v.split(",").pop()?.trim() ?? "";
    searchContacts(token);
  };

  const applySuggestion = (s: ContactSuggestion) => {
    const parts = composeTo.split(",");
    parts[parts.length - 1] = s.name ? `"${s.name}" <${s.email}>` : s.email;
    setComposeTo(parts.join(", ") + ", ");
    setSuggOpen(false);
    setSuggestions([]);
    setTimeout(() => toRef.current?.focus(), 0);
  };

  const handleToKeyDown = (e: React.KeyboardEvent) => {
    if (!suggOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") {
      if (suggestions[highlightIdx]) { e.preventDefault(); applySuggestion(suggestions[highlightIdx]); }
    } else if (e.key === "Escape") { setSuggOpen(false); }
  };

  const canSend = composeTo.trim().length > 0 && composeSubject.trim().length > 0 && !isSending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-[#111113] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-zinc-200">{composeHtmlAppend ? "İlet" : tr.compose.title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-zinc-400 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1">
          {/* From — only when 2+ accounts */}
          {accounts.length > 1 && (
            <div ref={fromRef} className="relative">
              <button
                type="button"
                onClick={() => setFromOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors text-left"
              >
                <span className="text-[10px] text-zinc-600 shrink-0 w-10">Kimden</span>
                {activeAccount?.picture ? (
                  <img src={activeAccount.picture} className="w-5 h-5 rounded-full shrink-0" alt="" />
                ) : (
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                    style={{ background: emailColor(activeAccount?.email ?? "") }}>
                    {activeAccount?.email[0]?.toUpperCase()}
                  </div>
                )}
                <span className="flex-1 min-w-0 text-xs text-zinc-300 truncate">{activeAccount?.email}</span>
                <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform ${fromOpen ? "rotate-180" : ""}`} />
              </button>
              {fromOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-[#18181b] border border-white/10 rounded-lg shadow-xl overflow-hidden">
                  {accounts.map(acc => (
                    <button key={acc.id} type="button"
                      onClick={() => { setComposeAccountId(acc.id); setFromOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/5 transition-colors text-left ${acc.id === composeAccountId ? "bg-white/[0.04]" : ""}`}
                    >
                      {acc.picture ? (
                        <img src={acc.picture} className="w-7 h-7 rounded-full shrink-0" alt="" />
                      ) : (
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                          style={{ background: emailColor(acc.email) }}>
                          {acc.email[0]?.toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-zinc-200 truncate">{acc.email.split("@")[0]}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{acc.email}</div>
                      </div>
                      {acc.id === composeAccountId && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* To field with autocomplete */}
          <div className="relative">
            <div className="relative flex items-center">
              <span className="absolute left-3 text-[10px] text-zinc-600 pointer-events-none">Kime</span>
              <input
                ref={toRef}
                value={composeTo}
                onChange={e => handleToChange(e.target.value)}
                onKeyDown={handleToKeyDown}
                onFocus={() => { if (suggestions.length > 0) setSuggOpen(true); }}
                placeholder="ornek@gmail.com"
                autoComplete="off"
                spellCheck={false}
                className={`${ui.input} pl-12`}
              />
            </div>
            {suggOpen && suggestions.length > 0 && (
              <div ref={suggRef} className="absolute left-0 right-0 top-full mt-1 z-20 bg-[#18181b] border border-white/10 rounded-lg shadow-xl overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={s.email}
                    type="button"
                    onMouseDown={e => { e.preventDefault(); applySuggestion(s); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${i === highlightIdx ? "bg-white/10" : "hover:bg-white/5"}`}
                    onMouseEnter={() => setHighlightIdx(i)}
                  >
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                      style={{ background: emailColor(s.email) }}
                    >
                      {(s.name || s.email)[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      {s.name && <div className="text-xs text-zinc-200 truncate">{s.name}</div>}
                      <div className={`truncate ${s.name ? "text-[10px] text-zinc-500" : "text-xs text-zinc-300"}`}>{s.email}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative flex items-center">
            <span className="absolute left-3 text-[10px] text-zinc-600 pointer-events-none">Konu</span>
            <input
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              placeholder="E-posta konusu"
              className={`${ui.input} pl-12`}
            />
          </div>

          <textarea
            value={composeBody}
            onChange={e => setComposeBody(e.target.value)}
            placeholder={tr.compose.body}
            className={`${ui.input} resize-none min-h-[200px]`}
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/5 space-y-2">
          {/* Inline error */}
          {sendError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 break-words">{sendError}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              {tr.compose.discard}
            </button>
            <button
              onClick={onSend}
              disabled={!canSend}
              className={`px-5 py-1.5 text-white text-xs font-medium rounded-lg transition-all flex items-center gap-2 ${
                isSending
                  ? "bg-blue-500/60 cursor-not-allowed"
                  : canSend
                  ? "bg-blue-500 hover:bg-blue-600 active:scale-95"
                  : "bg-blue-500/30 cursor-not-allowed opacity-50"
              }`}
            >
              {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {isSending ? tr.compose.sending : tr.compose.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

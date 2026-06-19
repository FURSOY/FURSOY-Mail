import { X, RefreshCw, Send } from "lucide-react";
import { tr } from "../i18n";
import { ui } from "../theme";

interface ComposeModalProps {
  composeTo: string;
  setComposeTo: (v: string) => void;
  composeSubject: string;
  setComposeSubject: (v: string) => void;
  composeBody: string;
  setComposeBody: (v: string) => void;
  composeHtmlAppend: string;
  isSending: boolean;
  onSend: () => void;
  onClose: () => void;
}

export function ComposeModal({
  composeTo, setComposeTo,
  composeSubject, setComposeSubject,
  composeBody, setComposeBody,
  composeHtmlAppend,
  isSending,
  onSend,
  onClose,
}: ComposeModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-[#111113] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-zinc-200">{composeHtmlAppend ? "İlet" : tr.compose.title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 flex-1">
          <input
            value={composeTo}
            onChange={e => setComposeTo(e.target.value)}
            placeholder={tr.compose.to}
            className={ui.input}
          />
          <input
            value={composeSubject}
            onChange={e => setComposeSubject(e.target.value)}
            placeholder={tr.compose.subject}
            className={ui.input}
          />
          <textarea
            value={composeBody}
            onChange={e => setComposeBody(e.target.value)}
            placeholder={tr.compose.body}
            className={`${ui.input} resize-none min-h-[200px]`}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {tr.compose.discard}
          </button>
          <button
            onClick={onSend}
            disabled={!composeTo.trim() || !composeSubject.trim() || isSending}
            className="px-5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {isSending ? tr.compose.sending : tr.compose.send}
          </button>
        </div>
      </div>
    </div>
  );
}

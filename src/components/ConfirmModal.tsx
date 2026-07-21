import { AlertTriangle } from "lucide-react";
import { useRef } from "react";
import { useLocale } from "../i18n";
import { status, typography, ui } from "../theme";

interface ConfirmModalProps {
  modal: { message: string; onConfirm: () => void } | null;
  onClose: () => void;
}

export function ConfirmModal({ modal, onClose }: ConfirmModalProps) {
  const tr = useLocale();
  const dialogRef = useRef<HTMLDivElement>(null);
  if (!modal) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-message"
        onKeyDown={handleKeyDown}
        className={`w-full max-w-sm ${ui.modal} p-6 mx-4`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className={`w-9 h-9 rounded-[var(--radius-md)] flex items-center justify-center shrink-0 ${status.danger}`}>
            <AlertTriangle className="w-4.5 h-4.5" />
          </div>
          <p id="confirm-modal-message" className={`${typography.body} leading-relaxed`}>{modal.message}</p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <button
            autoFocus
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/5 transition-colors"
          >
            {tr.common.cancel}
          </button>
          <button
            onClick={() => { modal.onConfirm(); onClose(); }}
            className="px-4 py-1.5 bg-[var(--color-action-danger)] hover:bg-[var(--color-action-danger-hover)] text-[var(--color-text-on-accent)] text-xs font-medium rounded-[var(--radius-md)] transition-colors"
          >
            {tr.mail.delete}
          </button>
        </div>
      </div>
    </div>
  );
}

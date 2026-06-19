import { AlertTriangle } from "lucide-react";

interface ConfirmModalProps {
  modal: { message: string; onConfirm: () => void } | null;
  onClose: () => void;
}

export function ConfirmModal({ modal, onClose }: ConfirmModalProps) {
  if (!modal) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-[#111113] border border-white/10 rounded-xl shadow-2xl p-6 mx-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-red-500/15 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4.5 h-4.5 text-red-400" />
          </div>
          <p className="text-sm text-zinc-200 leading-relaxed">{modal.message}</p>
        </div>
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/5 transition-colors"
          >
            İptal
          </button>
          <button
            onClick={() => { modal.onConfirm(); onClose(); }}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
          >
            Sil
          </button>
        </div>
      </div>
    </div>
  );
}

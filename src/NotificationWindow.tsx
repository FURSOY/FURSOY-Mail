import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X, Copy, Mail } from "lucide-react";
import "./index.css";

interface NotificationPayload {
  title: string;
  body: string;
  code?: string | null;
}

export default function NotificationWindow() {
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const closeWindow = async () => {
    setIsClosing(true);
    setTimeout(async () => {
      try {
        await getCurrentWindow().close();
      } catch {}
    }, 300);
  };

  const handleOpenMail = async () => {
    try {
      await invoke("focus_main_window");
    } catch (e) {
      console.error("focus_main_window failed:", e);
    }
    closeWindow();
  };

  // Auto-close after 5 seconds
  useEffect(() => {
    let timer: number;
    if (payload && !isClosing) {
      timer = window.setTimeout(() => closeWindow(), 5000);
    }
    return () => clearTimeout(timer);
  }, [payload, isClosing]);

  // On mount: read pending notification from Rust state
  useEffect(() => {
    invoke<NotificationPayload | null>("get_pending_notification").then((data) => {
      if (data) setPayload(data);
    }).catch(console.error);

    const unlisten = listen<NotificationPayload>("new-notification", (event) => {
      setPayload(event.payload);
      setIsClosing(false);
    });

    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (payload?.code) {
      await writeText(payload.code);
      closeWindow();
    }
  };

  return (
    <>
      <style>{`
        @keyframes shrink { from { width: 100%; } to { width: 0%; } }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { height: 100%; }
        body { height: 100%; background: #18181b !important; overflow: hidden !important; }
        #root { height: 100%; }
      `}</style>

      {/* Full window container — fills 100% of the window height */}
      <div
        onClick={handleOpenMail}
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#18181b",
          color: "#f4f4f5",
          userSelect: "none",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {/* Content area — flex:1 pushes progress bar to bottom */}
        <div
          style={{
            flex: 1,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            position: "relative",
            opacity: isClosing ? 0 : 1,
            transition: "opacity 300ms",
            minHeight: 0,
          }}
        >
          {/* Close Button */}
          <button
            onClick={(e) => { e.stopPropagation(); closeWindow(); }}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 6, color: "#71717a", background: "transparent",
              border: "none", cursor: "pointer", zIndex: 10,
            }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>

          {/* Mail content */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingRight: 24 }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: "rgba(59,130,246,0.2)", display: "flex",
              alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2,
            }}>
              <Mail style={{ width: 16, height: 16, color: "#60a5fa" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden", minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: "#f4f4f5",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {payload?.title || "Yükleniyor..."}
              </div>
              <div style={{
                fontSize: 12, color: "#a1a1aa", lineHeight: 1.4,
                display: "-webkit-box", WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical" as any, overflow: "hidden",
              }}>
                {payload?.body || ""}
              </div>
            </div>
          </div>

          {/* Copy Code Button */}
          {payload?.code && (
            <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={handleCopy}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 12px", background: "#3b82f6", color: "white",
                  fontSize: 12, fontWeight: 500, borderRadius: 8,
                  border: "none", cursor: "pointer",
                }}
              >
                <Copy style={{ width: 14, height: 14 }} />
                <span>Kodu Kopyala ({payload.code})</span>
              </button>
            </div>
          )}
        </div>

        {/* Progress bar — always at the very bottom edge of the window */}
        {payload && (
          <div style={{ width: "100%", height: 3, flexShrink: 0 }}>
            <div style={{
              height: 3, background: "#3b82f6",
              animation: "shrink 5s linear forwards",
            }} />
          </div>
        )}
      </div>
    </>
  );
}

import { useRef, useCallback, useEffect } from "react";
import type { MailZoom } from "../types";
import { FIXED_LAYOUT_MIN_WIDTH, buildEmailSrcDoc, findEmailUrl, resolveEmailUrl } from "../utils";

export function EmailHtmlView({
  html,
  zoom,
  relayoutKey,
  onFitScaleChange,
  onOpenUrl,
  scrollRef,
}: {
  html: string;
  zoom: MailZoom;
  relayoutKey?: string | number;
  onFitScaleChange?: (scale: number) => void;
  onOpenUrl: (url: string) => void;
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const applyScale = useCallback(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!host || !stage || !frame) return;
    const doc = frame.contentDocument;
    const root = doc?.querySelector(".mail-root") as HTMLElement | null;
    if (!doc || !root) return;

    const available = Math.max(1, host.clientWidth);

    if (zoom === "fit") {
      frame.style.height = "auto";
      frame.style.width = `${available}px`;

      const overflowWidth = root.scrollWidth;
      if (overflowWidth > available + 1) {
        const fitScale = available / overflowWidth;
        frame.style.width = `${overflowWidth}px`;
        const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
        frame.style.height = `${layoutHeight}px`;
        frame.style.transform = `scale(${fitScale})`;
        stage.style.width = `${Math.floor(overflowWidth * fitScale)}px`;
        stage.style.height = `${Math.floor(layoutHeight * fitScale)}px`;
        onFitScaleChange?.(fitScale);
      } else {
        const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
        frame.style.height = `${layoutHeight}px`;
        frame.style.transform = "none";
        stage.style.width = `${available}px`;
        stage.style.height = `${layoutHeight}px`;
        onFitScaleChange?.(1);
      }
      return;
    }

    frame.style.height = "auto";
    frame.style.width = "0px";
    const minContentWidth = Math.max(root.scrollWidth, 1);

    let layoutWidth: number;
    if (minContentWidth >= FIXED_LAYOUT_MIN_WIDTH) {
      layoutWidth = minContentWidth;
    } else {
      const target = Math.max(80, Math.round(available / zoom));
      frame.style.width = `${target}px`;
      layoutWidth = Math.max(root.scrollWidth, target);
    }

    frame.style.width = `${layoutWidth}px`;
    const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
    frame.style.height = `${layoutHeight}px`;
    frame.style.transform = `scale(${zoom})`;
    stage.style.width = `${Math.floor(layoutWidth * zoom)}px`;
    stage.style.height = `${Math.floor(layoutHeight * zoom)}px`;
  }, [zoom, onFitScaleChange]);

  const applyScaleRef = useRef(applyScale);
  applyScaleRef.current = applyScale;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let innerCleanup: (() => void) | null = null;

    const handleLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;

      if (!doc.querySelector(".mail-root")) {
        const navUrl = (() => {
          try { return frame.contentWindow?.location.href ?? null; } catch { return null; }
        })();
        frame.srcdoc = buildEmailSrcDoc(html);
        if (navUrl && navUrl !== "about:blank" && /^https?:/i.test(navUrl)) {
          onOpenUrl(navUrl);
        }
        return;
      }

      const remeasure = () => applyScaleRef.current();
      remeasure();

      const images = Array.from(doc.images);
      images.forEach((img) => img.addEventListener("load", remeasure));

      doc.fonts?.ready.then(remeasure).catch(() => {});

      let targetScrollTop = -1;
      let smoothRaf = 0;
      const handleWheel = (e: WheelEvent) => {
        const outer = scrollRef?.current;
        if (!outer) return;
        let dy = e.deltaY;
        const dx = e.deltaX;
        if (e.deltaMode === 1) { dy *= 40; }
        else if (e.deltaMode === 2) { dy *= outer.clientHeight; }
        if (targetScrollTop < 0) targetScrollTop = outer.scrollTop;
        const maxScroll = outer.scrollHeight - outer.clientHeight;
        targetScrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop + dy));
        if (dx !== 0) outer.scrollLeft += dx;
        if (!smoothRaf) {
          const step = () => {
            const diff = targetScrollTop - outer.scrollTop;
            if (Math.abs(diff) < 0.5) {
              outer.scrollTop = targetScrollTop;
              smoothRaf = 0;
              return;
            }
            outer.scrollTop += diff * 0.2;
            smoothRaf = requestAnimationFrame(step);
          };
          smoothRaf = requestAnimationFrame(step);
        }
      };
      doc.addEventListener("wheel", handleWheel, { passive: true });

      const handleClick = (event: Event) => {
        const url = findEmailUrl(event.target);
        const isInteractive = url !== null ||
          !!(event.target as Element | null)?.closest?.("a, area, button, [role='button']");
        if (isInteractive) event.preventDefault();
        if (!url) return;
        event.stopPropagation();
        onOpenUrl(url);
      };
      const handleSubmit = (event: Event) => {
        const node = event.target as Element | null;
        const form = node?.closest?.("form") as HTMLFormElement | null;
        const url = resolveEmailUrl(form?.getAttribute("action"));
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenUrl(url);
      };
      doc.addEventListener("click", handleClick, true);
      doc.addEventListener("submit", handleSubmit, true);
      const handleContextMenu = (e: Event) => e.preventDefault();
      doc.addEventListener("contextmenu", handleContextMenu, true);

      innerCleanup = () => {
        cancelAnimationFrame(smoothRaf);
        images.forEach((img) => img.removeEventListener("load", remeasure));
        doc.removeEventListener("wheel", handleWheel);
        doc.removeEventListener("click", handleClick, true);
        doc.removeEventListener("submit", handleSubmit, true);
        doc.removeEventListener("contextmenu", handleContextMenu, true);
      };
    };

    frame.addEventListener("load", handleLoad);
    frame.srcdoc = buildEmailSrcDoc(html);

    return () => {
      frame.removeEventListener("load", handleLoad);
      innerCleanup?.();
    };
  }, [html, onOpenUrl, scrollRef]);

  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = requestAnimationFrame(() => {
        applyScale();
        timer = window.setTimeout(() => applyScale(), 260);
      });
    };
    schedule();
    const host = hostRef.current;
    if (!host) return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      resizeObserver.disconnect();
    };
  }, [applyScale, relayoutKey]);

  return (
    <div ref={hostRef} className="relative w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-contain bg-white select-text">
      <div ref={stageRef} className="relative mx-auto">
        <iframe
          ref={frameRef}
          title="Email content"
          sandbox="allow-same-origin allow-popups"
          className="absolute left-0 top-0 block border-0 bg-white"
          style={{ transformOrigin: "top left", width: 0, height: 0 }}
        />
      </div>
    </div>
  );
}

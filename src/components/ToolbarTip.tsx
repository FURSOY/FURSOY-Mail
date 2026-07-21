import { cloneElement, useId, type ReactElement } from "react";
import { ui } from "../theme";

export function ToolbarTip({ label, children }: { label: string; children: ReactElement<{ "aria-label"?: string; "aria-describedby"?: string }> }) {
  const tooltipId = useId();
  return (
    <div className="group/tip relative inline-flex">
      {cloneElement(children, {
        "aria-label": children.props["aria-label"] ?? label,
        "aria-describedby": children.props["aria-describedby"] ?? tooltipId,
      })}
      <span
        id={tooltipId}
        className={`pointer-events-none absolute left-1/2 z-[200] mt-1.5 w-max max-w-[220px] -translate-x-1/2 top-full text-center leading-tight opacity-0 transition-opacity duration-150 delay-75 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 ${ui.tooltip}`}
        role="tooltip"
      >
        {label}
      </span>
    </div>
  );
}

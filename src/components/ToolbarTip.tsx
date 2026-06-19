import type { ReactNode } from "react";

export function ToolbarTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="group/tip relative inline-flex">
      {children}
      <span
        className="pointer-events-none absolute left-1/2 z-[200] mt-1.5 w-max max-w-[220px] -translate-x-1/2 top-full rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-center text-[10px] font-medium leading-tight text-zinc-200 opacity-0 shadow-lg transition-opacity duration-150 delay-75 group-hover/tip:opacity-100"
        role="tooltip"
      >
        {label}
      </span>
    </div>
  );
}

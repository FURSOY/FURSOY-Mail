export const ui = {
  card: "rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-subtle)]",
  panel:
    "rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-app)]",
  modal:
    "rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-surface-panel)] shadow-2xl",
  iconButton:
    "rounded-[var(--radius-sm)] p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]",
  tooltip:
    "rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-surface-app)] px-2 py-1 text-[length:var(--font-size-caption)] font-medium text-[var(--color-text-secondary)] shadow-lg",
  buttonPrimary:
    "rounded-[var(--radius-md)] bg-[var(--app-accent)] px-4 py-2 text-[length:var(--font-size-body)] font-semibold text-[var(--color-text-on-accent)] shadow-[var(--shadow-accent-lg)] transition-colors hover:bg-[var(--app-accent-hover)] disabled:opacity-50",
  buttonSecondary:
    "rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-app)] px-4 py-2 text-[length:var(--font-size-body)] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50",
  input:
    "w-full select-text rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-control)] px-3 py-2 text-[length:var(--font-size-body)] text-[var(--color-text-secondary)] outline-none placeholder:text-[var(--color-text-disabled)] focus:border-[var(--app-accent)]/50",
};

export const typography = {
  micro: "text-[length:var(--font-size-micro)]",
  pageTitle:
    "text-[length:var(--font-size-page-title)] font-bold text-[var(--color-text-primary)]",
  title: "text-[length:var(--font-size-title)] font-bold text-[var(--color-text-primary)]",
  sectionTitle:
    "text-[length:var(--font-size-body)] font-semibold text-[var(--color-text-secondary)]",
  body: "text-[length:var(--font-size-body)] text-[var(--color-text-secondary)]",
  bodyMuted:
    "text-[length:var(--font-size-compact)] text-[var(--color-text-subtle)]",
  metadata:
    "text-[length:var(--font-size-metadata)] text-[var(--color-text-subtle)]",
  caption:
    "text-[length:var(--font-size-caption)] text-[var(--color-text-disabled)]",
};

export const surfaces = {
  app: "bg-[var(--color-surface-app)]",
  content: "bg-[var(--color-surface-content)]",
  sidebar: "bg-[var(--color-surface-sidebar)]",
  sidebarOverlay: "bg-[color:var(--color-surface-sidebar)]/95",
  panel: "bg-[var(--color-surface-panel)]",
  popover: "bg-[var(--color-surface-popover)]",
};

export const status = {
  info: "text-[var(--color-status-info)] bg-[var(--color-status-info-soft)]",
  success: "text-[var(--color-status-success)] bg-[var(--color-status-success-soft)]",
  warning: "text-[var(--color-status-warning)] bg-[var(--color-status-warning-soft)]",
  danger: "text-[var(--color-status-danger)] bg-[var(--color-status-danger-soft)]",
};

export const themePresets = {
  blue: {
    label: "Blue",
    accent: "#3b82f6",
    accentHover: "#2563eb",
    accentSoft: "rgb(59 130 246 / 0.14)",
    accentShadow: "rgb(59 130 246 / 0.25)",
  },
  emerald: {
    label: "Green",
    accent: "#10b981",
    accentHover: "#059669",
    accentSoft: "rgb(16 185 129 / 0.14)",
    accentShadow: "rgb(16 185 129 / 0.25)",
  },
  violet: {
    label: "Purple",
    accent: "#8b5cf6",
    accentHover: "#7c3aed",
    accentSoft: "rgb(139 92 246 / 0.14)",
    accentShadow: "rgb(139 92 246 / 0.25)",
  },
  rose: {
    label: "Rose",
    accent: "#f43f5e",
    accentHover: "#e11d48",
    accentSoft: "rgb(244 63 94 / 0.14)",
    accentShadow: "rgb(244 63 94 / 0.25)",
  },
  amber: {
    label: "Amber",
    accent: "#f59e0b",
    accentHover: "#d97706",
    accentSoft: "rgb(245 158 11 / 0.14)",
    accentShadow: "rgb(245 158 11 / 0.25)",
  },
} as const;

export type ThemePresetName = keyof typeof themePresets;

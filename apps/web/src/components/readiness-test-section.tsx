"use client";

import type { ReactNode } from "react";

export type ReadinessTestSectionTone = "violet" | "indigo";

const TONE_STYLES: Record<
  ReadinessTestSectionTone,
  { shell: string; summary: string; body: string }
> = {
  violet: {
    shell: "border-violet-100 bg-violet-50/40 dark:border-violet-900/40",
    summary: "text-violet-950",
    body: "text-violet-800",
  },
  indigo: {
    shell: "border-indigo-100 bg-indigo-50/40 dark:border-indigo-900/40",
    summary: "text-indigo-950",
    body: "text-indigo-800",
  },
};

export function ReadinessTestSection({
  title,
  summaryHint,
  open,
  onOpenChange,
  locked,
  intro,
  blockedMessage,
  tone,
  children,
}: {
  title: string;
  /** Progreso o prerequisito; vacío si el pill del paso/habilidad ya resume el estado. */
  summaryHint?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locked: boolean;
  intro?: string | null;
  blockedMessage?: string | null;
  tone: ReadinessTestSectionTone;
  children: ReactNode;
}) {
  const styles = TONE_STYLES[tone];
  const hint = summaryHint?.trim() ?? "";

  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className={`rounded border text-[11px] ${styles.shell} ${
        locked && !open ? "opacity-90" : ""
      }`}
    >
      <summary
        aria-expanded={open}
        className={`cursor-pointer list-none p-2 marker:content-none [&::-webkit-details-marker]:hidden ${styles.summary}`}
      >
        <div className="flex items-start gap-1.5">
          <span
            aria-hidden
            className={`mt-0.5 inline-block shrink-0 text-[10px] leading-none transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{title}</div>
            {hint ? (
              <p className={`mt-0.5 text-[11px] font-normal ${styles.body}`}>
                {hint}
              </p>
            ) : null}
          </div>
        </div>
      </summary>
      {open ? (
        <div className="space-y-2 border-t border-white/60 px-2 pb-2 pt-2 dark:border-neutral-800">
          {intro ? <p className={styles.body}>{intro}</p> : null}
          {locked && blockedMessage ? (
            <p className="rounded border border-amber-200 bg-amber-50/90 p-2 text-amber-950">
              {blockedMessage}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </details>
  );
}

export const SIDEBAR_DIVIDER_LINE =
  "h-px shrink-0 bg-neutral-200 dark:bg-neutral-800";

type SidebarInsetDividerProps = {
  label: string;
};

export function SidebarInsetDivider({ label }: SidebarInsetDividerProps) {
  return (
    <div className="relative px-2">
      <p
        className="invisible text-xs font-semibold uppercase tracking-wide"
        aria-hidden="true"
      >
        {label}
      </p>
      <div
        className={`absolute inset-x-2 top-1/2 ${SIDEBAR_DIVIDER_LINE} -translate-y-1/2`}
        aria-hidden="true"
      />
    </div>
  );
}

export function SidebarFullDivider() {
  return (
    <div className={`${SIDEBAR_DIVIDER_LINE} w-full`} role="separator" aria-hidden="true" />
  );
}

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { AppNav } from "@/components/app-nav";
import { SidebarFullDivider } from "@/components/sidebar-divider";

type AppShellProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** When true, main content fills the viewport below the header (for chat-like layouts). */
  viewportFill?: boolean;
  children: ReactNode;
};

type SidebarMode = "expanded" | "collapsed" | "hover";

const SIDEBAR_MODE_STORAGE_KEY = "ungga.sidebarMode";

const SIDEBAR_CONTROL_ROW =
  "grid h-10 grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 rounded-xl px-3";

function SidebarModeIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M9 5v14M12 9h5M12 12h5M12 15h5" />
    </svg>
  );
}

export function AppShell({
  title,
  description,
  actions,
  viewportFill = false,
  children,
}: AppShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [headerTitle, setHeaderTitle] = useState(title);
  const [headerDescription, setHeaderDescription] = useState(description);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    if (typeof window === "undefined") return "hover";
    const saved = window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY);
    if (saved === "expanded" || saved === "collapsed" || saved === "hover") {
      return saved;
    }
    return "hover";
  });
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const isHydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_MODE_STORAGE_KEY, sidebarMode);
  }, [sidebarMode]);

  useEffect(() => {
    setHeaderTitle(title);
    setHeaderDescription(description);
  }, [title, description]);

  useEffect(() => {
    const onHeaderEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{
        title?: string;
        description?: string;
      }>;
      if (!customEvent.detail?.title) return;
      setHeaderTitle(customEvent.detail.title);
      setHeaderDescription(customEvent.detail.description);
    };
    window.addEventListener("app-shell-header", onHeaderEvent as EventListener);
    return () => {
      window.removeEventListener("app-shell-header", onHeaderEvent as EventListener);
    };
  }, []);

  const desktopExpanded = useMemo(() => {
    if (!isHydrated) return false;
    if (sidebarMode === "expanded") return true;
    if (sidebarMode === "collapsed") return false;
    return sidebarHovered;
  }, [isHydrated, sidebarHovered, sidebarMode]);
  const desktopHoverOverlay = viewportFill && sidebarMode === "hover";
  const desktopSidebarClassName = `hidden h-screen shrink-0 border-r border-neutral-200 p-4 transition-[width] duration-200 dark:border-neutral-800 lg:flex lg:flex-col ${
    desktopHoverOverlay
      ? "absolute inset-y-0 left-0 z-30 bg-white dark:bg-neutral-900"
      : viewportFill
        ? "sticky top-0 bg-white dark:bg-neutral-900"
        : "sticky top-0 bg-white/85 backdrop-blur dark:bg-neutral-900/60"
  } ${desktopExpanded ? "w-72" : "w-24"}`;

  return (
    <div
      className={`bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 ${
        viewportFill
          ? "flex h-[100dvh] min-h-0 flex-col overflow-hidden"
          : "min-h-screen"
      }`}
    >
      {mobileMenuOpen ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
        />
      ) : null}

      <div
        className={`mx-auto flex w-full max-w-[1440px] ${
          viewportFill ? "min-h-0 flex-1 overflow-hidden" : ""
        }`}
      >
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-neutral-200 bg-white/95 p-4 backdrop-blur transition-transform duration-300 dark:border-neutral-800 dark:bg-neutral-900/95 lg:hidden ${
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="mb-5 flex items-center justify-between px-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-300">
                UNGGA
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Cerrar
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <AppNav />
          </div>
          <div className="mt-6 space-y-4">
            <SidebarFullDivider />
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Cerrar sesión
              </button>
            </form>
          </div>
        </aside>

        <div
          className={`relative hidden lg:block ${
            desktopHoverOverlay ? "w-24 shrink-0" : ""
          }`}
        >
          <aside
            onMouseEnter={() => setSidebarHovered(true)}
            onMouseLeave={() => setSidebarHovered(false)}
            className={desktopSidebarClassName}
          >
            <div className="mb-2 px-2">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-700 dark:text-violet-300">
                UNGGA
              </p>
            </div>
            <div className="mb-1">
              {desktopExpanded ? (
                <div className={SIDEBAR_CONTROL_ROW}>
                  <span className="flex justify-center text-neutral-600 dark:text-neutral-300">
                    <SidebarModeIcon />
                  </span>
                  <select
                    value={sidebarMode}
                    onChange={(event) => setSidebarMode(event.target.value as SidebarMode)}
                    aria-label="Modo del menú"
                    className="h-7 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  >
                    <option value="expanded">Expandido</option>
                    <option value="collapsed">Compacto</option>
                    <option value="hover">Expandir al pasar</option>
                  </select>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setSidebarMode("expanded")}
                  className={`${SIDEBAR_CONTROL_ROW} w-full text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800`}
                  title="Expandir menú"
                  aria-label="Expandir menú"
                >
                  <span className="flex justify-center">
                    <SidebarModeIcon />
                  </span>
                </button>
              )}
            </div>
            <div
              className={`min-h-0 flex-1 overflow-y-auto ${
                desktopExpanded
                  ? "pr-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                  : "pr-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              }`}
            >
              <AppNav compact={!desktopExpanded} />
            </div>
            <div className="mt-6 space-y-4">
              <SidebarFullDivider />
              <form action="/api/auth/signout" method="POST">
                <button
                  type="submit"
                  className={`w-full rounded-lg border border-neutral-300 px-3 py-2 font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 ${
                    desktopExpanded ? "text-sm" : "text-xs"
                  }`}
                >
                  {desktopExpanded ? "Cerrar sesión" : "Salir"}
                </button>
              </form>
            </div>
          </aside>
        </div>

        <div
          className={`min-w-0 flex-1 ${
            viewportFill ? "flex min-h-0 flex-col overflow-hidden" : ""
          }`}
        >
          <header
            className={`sticky top-0 z-10 shrink-0 border-b border-neutral-200 px-4 py-4 dark:border-neutral-800 ${
              viewportFill
                ? "bg-white dark:bg-neutral-900"
                : "bg-white/80 backdrop-blur dark:bg-neutral-900/70"
            }`}
          >
            <div className="mx-auto w-full max-w-7xl">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(true)}
                    className="mb-2 rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 lg:hidden"
                  >
                    Menú
                  </button>
                  <h2 className="text-xl font-semibold">{headerTitle}</h2>
                  {headerDescription ? (
                    <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-300">
                      {headerDescription}
                    </p>
                  ) : null}
                </div>
                {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
              </div>
            </div>
          </header>

          <main
            className={`mx-auto w-full max-w-7xl p-4 lg:p-6 ${
              viewportFill ? "flex min-h-0 flex-1 flex-col overflow-hidden" : ""
            }`}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}


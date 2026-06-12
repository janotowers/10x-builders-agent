"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  APP_NAV_TREE,
  type AppNavMatcher,
  type AppNavNode,
} from "@/lib/navigation/app-navigation";
import { SidebarInsetDivider } from "@/components/sidebar-divider";

type NavIconName = AppNavNode["icon"];

function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    className: "h-4 w-4",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
  };

  switch (name) {
    case "chat":
      return <svg {...common}><path d="M5 6.5h14v9H9l-4 3v-12Z" /><path d="M8 10h8M8 13h5" /></svg>;
    case "bell":
      return <svg {...common}><path d="M18 9a6 6 0 0 0-12 0c0 7-2 7-2 8h16c0-1-2-1-2-8Z" /><path d="M10 20h4" /></svg>;
    case "flow":
      return <svg {...common}><path d="M6 7h4v4H6zM14 13h4v4h-4zM10 9h2a3 3 0 0 1 3 3v1" /><path d="M12 17H8a2 2 0 0 1-2-2v-4" /></svg>;
    case "template":
      return <svg {...common}><path d="M7 4h10l3 3v13H7z" /><path d="M17 4v4h4M10 11h7M10 15h7" /></svg>;
    case "pulse":
      return <svg {...common}><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>;
    case "memory":
      return <svg {...common}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg>;
    case "user":
      return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>;
    case "agent":
      return <svg {...common}><path d="M8 9h8v7H8zM12 5v4M9 19h6" /><path d="M9.5 12h.01M14.5 12h.01" /></svg>;
    case "sliders":
      return <svg {...common}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>;
    case "spark":
      return <svg {...common}><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></svg>;
    case "tool":
      return <svg {...common}><path d="M14 7l3-3 3 3-3 3" /><path d="M16 8L7 17l-3 1 1-3 9-9" /></svg>;
    case "plug":
      return <svg {...common}><path d="M9 7V4M15 7V4M7 7h10v4a5 5 0 0 1-10 0V7Z" /><path d="M12 16v4" /></svg>;
    case "channel":
      return <svg {...common}><path d="M4 6h16v10H8l-4 4V6Z" /><path d="M8 10h8" /></svg>;
    case "key":
      return <svg {...common}><circle cx="8" cy="12" r="4" /><path d="M12 12h8M17 12v3M20 12v2" /></svg>;
    case "account":
      return <svg {...common}><path d="M7 10V8a5 5 0 0 1 10 0v2" /><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M12 14v2" /></svg>;
  }
}

function matchesRule(
  matcher: AppNavMatcher | undefined,
  pathname: string,
  searchParams: URLSearchParams
): boolean {
  if (!matcher) return false;
  if (matcher === "chat-pending") {
    return pathname === "/chat" && searchParams.get("pendientes") === "1";
  }
  if (matcher === "chat-conversation") {
    return pathname === "/chat" && searchParams.get("pendientes") !== "1";
  }
  if (matcher.kind === "settings-view") {
    const currentView = searchParams.get("view") ?? "profile-user";
    return pathname === "/settings" && currentView === matcher.view;
  }
  return false;
}

function normalizeHrefPath(href: string): string {
  try {
    return new URL(href, "https://ungga.local").pathname;
  } catch {
    return href;
  }
}

function scrollMainContentToTop() {
  if (typeof window === "undefined") return;
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function isSelfActive(
  node: AppNavNode,
  pathname: string,
  searchParams: URLSearchParams
): boolean {
  if (node.matcher) {
    return matchesRule(node.matcher, pathname, searchParams);
  }

  if (node.href) {
    const targetPath = normalizeHrefPath(node.href);
    if (
      pathname === targetPath ||
      (targetPath !== "/" && pathname.startsWith(`${targetPath}/`))
    ) {
      return true;
    }
  }

  return false;
}

const NAV_LINK_GRID =
  "grid min-h-10 grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2 rounded-xl px-3 py-2";

function renderNode(
  node: AppNavNode,
  pathname: string,
  searchParams: URLSearchParams,
  compact: boolean,
  depth = 0
) {
  const selfActive = isSelfActive(node, pathname, searchParams);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const indent = depth <= 1 ? "" : "pl-5";
  const linkClassName = selfActive
    ? "font-semibold text-neutral-900 dark:text-neutral-100"
    : "text-neutral-600 dark:text-neutral-300";

  if (compact) {
    if (!node.href) {
      return (
        <li key={node.key} className="space-y-1">
          <SidebarInsetDivider label={node.label} />
          <ul className="space-y-1">
            {(node.children ?? []).map((child) =>
              renderNode(child, pathname, searchParams, compact, depth + 1)
            )}
          </ul>
        </li>
      );
    }

    return (
      <li key={node.key} className={indent}>
        <a
          href={node.href}
          title={node.label}
          aria-label={node.label}
          aria-current={selfActive ? "page" : undefined}
          onClick={scrollMainContentToTop}
          className={`${NAV_LINK_GRID} transition hover:bg-neutral-100 dark:hover:bg-neutral-800 ${linkClassName}`}
        >
          <span className="flex justify-center">
            <NavIcon name={node.icon} />
          </span>
        </a>
      </li>
    );
  }

  return (
    <li key={node.key} className={`space-y-1 ${indent}`}>
      {node.href ? (
        <a
          href={node.href}
          aria-current={selfActive ? "page" : undefined}
          onClick={scrollMainContentToTop}
          className={`${NAV_LINK_GRID} text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800 ${linkClassName}`}
        >
          <span className="flex justify-center">
            <NavIcon name={node.icon} />
          </span>
          <span className="truncate">{node.label}</span>
        </a>
      ) : (
        <p className="px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {node.label}
        </p>
      )}

      {hasChildren ? (
        <ul className="space-y-1">
          {node.children!.map((child) =>
            renderNode(child, pathname, searchParams, compact, depth + 1)
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function AppNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <nav aria-label="Navegación principal">
      <ul className="space-y-4">
        {APP_NAV_TREE.map((node) =>
          renderNode(node, pathname, searchParams, compact)
        )}
      </ul>
    </nav>
  );
}


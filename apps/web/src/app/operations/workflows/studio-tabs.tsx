/**
 * Pestañas del Workflow Studio (Slice 4.2-4): el shell 2.7 (catálogo +
 * recursos) se absorbe — no se reconstruye — y gana la pestaña de Diseño
 * (compilador + gates + publicación). Mismo patrón que Control operativo.
 */
import Link from "next/link";

const TABS = [
  { id: "catalog", label: "Catálogo", href: "/operations/workflows" },
  { id: "design", label: "Diseño", href: "/operations/workflows/design" },
  { id: "assets", label: "Recursos", href: "/operations/workflows/assets" },
] as const;

export type WorkflowStudioTabId = (typeof TABS)[number]["id"];

export function WorkflowStudioTabs({ active }: { active: WorkflowStudioTabId }) {
  return (
    <div className="mb-4 flex w-fit flex-wrap gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1 dark:border-neutral-800 dark:bg-neutral-950">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
            tab.id === active
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

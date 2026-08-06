/**
 * Pestañas de "Control operativo": Trabajo durable (casos / tareas),
 * Unidades de trabajo (work items), Cambios y reparaciones (impacto).
 * Cada ruta es su propia página de servidor; las pestañas son navegación.
 */
import Link from "next/link";

const TABS = [
  { id: "overview", label: "Trabajo durable", href: "/operations/overview" },
  { id: "work", label: "Unidades de trabajo", href: "/operations/work" },
  {
    id: "impact",
    label: "Cambios y reparaciones",
    href: "/operations/impact",
  },
] as const;

export type OperationsControlTabId = (typeof TABS)[number]["id"];

export function OperationsControlTabs({
  active,
}: {
  active: OperationsControlTabId;
}) {
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

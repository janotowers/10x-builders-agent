/**
 * Pestañas de "Control operativo" (consolidación de navegación, inicio de
 * Phase 4): una sola entrada del sidebar agrupa las dos superficies del
 * operador — el plano de trabajo (/operations/work) y la vista de impacto
 * (/operations/impact) — como pestañas, siguiendo el patrón de secciones de
 * Proactividad. Cada ruta sigue siendo su propia página de servidor con sus
 * server actions; las pestañas son solo navegación.
 */
import Link from "next/link";

const TABS = [
  { id: "work", label: "Trabajo", href: "/operations/work" },
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

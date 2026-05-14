import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  listOperationalCaseTypesForUser,
} from "@agents/db";
import { OperationalCaseTypesClient } from "./operational-case-types-client";

export const dynamic = "force-dynamic";

export default async function OperationalCaseTypesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const caseTypes = await listOperationalCaseTypesForUser(db, user.id, {
    includeArchived: true,
  });

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-700 dark:text-violet-300">
            Ajustes
          </p>
          <h1 className="text-2xl font-bold">Casos de uso</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Configura plantillas operativas. Luego aparecen en Casos para
            iniciar casos en operación con formularios dinámicos.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href="/operational-cases"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Casos
          </a>
          <a
            href="/settings"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Ajustes
          </a>
        </div>
      </header>

      <OperationalCaseTypesClient initialCaseTypes={caseTypes} />
    </main>
  );
}

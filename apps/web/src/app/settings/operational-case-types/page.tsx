import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getRecentOperationalCaseEvents,
  listOperationalCasesForUser,
  listOperationalCaseTypesForUser,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import { OperationalCaseTypesClient } from "./operational-case-types-client";
import { BfcacheRecoveryBoundary } from "./bfcache-recovery-boundary";

export const dynamic = "force-dynamic";

export default async function OperationalCaseTypesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const [caseTypes, operationalCases, registry] = await Promise.all([
    listOperationalCaseTypesForUser(db, user.id, {
      includeArchived: true,
    }),
    listOperationalCasesForUser(db, user.id, {
      statuses: [
        "active",
        "waiting_internal",
        "waiting_external",
        "paused",
        "completed",
        "failed",
      ],
      limit: 500,
    }),
    getSkillRegistryForUser(db, user.id).catch((err) => {
      console.warn(
        "[operational-case-types] failed to load skill registry:",
        err
      );
      return null;
    }),
  ]);
  const skillSummaries =
    registry?.list().map((skill) => ({
      slug: skill.name,
      description: skill.description,
      scope: skill.scope,
      allowedTools: [...skill.allowedTools],
      includes: [...skill.includes],
      kind: skill.includes.length > 0 ? "composite" : "atomic",
    })) ?? [];
  const latestEventsByCaseId = Object.fromEntries(
    (
      await Promise.all(
        operationalCases.map((opCase) =>
          getRecentOperationalCaseEvents(db, opCase.id, 1)
        )
      )
    )
      .flat()
      .map((event) => [event.case_id, event] as const)
  );

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-700 dark:text-violet-300">
            Operaciones
          </p>
          <h1 className="text-2xl font-bold">Casos de uso</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Diseña, prueba y activa plantillas operativas. Cada plantilla puede
            originar casos en operación desde chat, Telegram o una creación
            manual controlada.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href="/operational-cases"
            title="Bandeja global con todas las instancias, sin filtrar por plantilla"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Todas las instancias
          </a>
          <a
            href="/settings"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Ajustes
          </a>
        </div>
      </header>

      <BfcacheRecoveryBoundary>
        <OperationalCaseTypesClient
          initialCaseTypes={caseTypes}
          initialOperationalCases={operationalCases}
          initialLatestEventsByCaseId={latestEventsByCaseId}
          initialSkillSummaries={skillSummaries}
        />
      </BfcacheRecoveryBoundary>
    </main>
  );
}

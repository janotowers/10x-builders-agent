import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getRecentOperationalCaseEvents,
  listOperationalCasesForUser,
  listOperationalCaseTypesForUser,
  listWorkflowDefinitionsVisibleToUser,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import {
  definitionStatusLabel,
  ownerScopeLabel,
} from "@/lib/workflow-studio/definition-catalog";
import { OperationalCaseTypesClient } from "./operational-case-types-client";
import { BfcacheRecoveryBoundary } from "./bfcache-recovery-boundary";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function OperationalCaseTypesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const [caseTypes, operationalCases, registry, workflowDefinitions] =
    await Promise.all([
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
      // Slice 1.6-1: opciones del selector de definición en N0.
      listWorkflowDefinitionsVisibleToUser(db, user.id).catch((err) => {
        console.warn(
          "[operational-case-types] failed to load workflow definitions:",
          err
        );
        return [];
      }),
    ]);
  const labDefinitionOptions = workflowDefinitions.map((definition) => ({
    id: definition.id,
    caseType: definition.case_type,
    workflowKey: definition.workflow_key,
    version: definition.version,
    status: definition.status,
    label: `${definition.workflow_key} · v${definition.version} · ${definitionStatusLabel(definition.status)} · ${ownerScopeLabel(definition.owner_scope)}`,
  }));
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
    <AppShell
      title="Plantillas de flujos"
      description="Diseña, prueba y activa plantillas operativas que generan casos en curso."
      actions={
        <a
          href="/operational-cases"
          title="Bandeja global con todas las instancias, sin filtrar por plantilla"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Ver casos en curso
        </a>
      }
    >
      <div className="space-y-6">
        {/* Slice 4.2-5: aviso de retiro del authoring del lab. El diseño y la
            publicación de definiciones viven ahora en el Workflow Studio; este
            laboratorio se conserva para diagnósticos (readiness de tools,
            pruebas E2E) hasta que el Studio cubra también la edición de
            plantillas de case types. */}
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          El diseño de flujos nuevos se movió a{" "}
          <a
            href="/operations/workflows/design"
            className="font-semibold underline"
          >
            Diseño de flujos
          </a>
          : ahí se describe el flujo, se valida, se simula y se publica con
          evidencia. Este laboratorio sigue disponible para diagnósticos
          (herramientas por paso, pruebas E2E) y para editar plantillas
          existentes mientras se completa la migración.
        </p>
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          Las políticas globales de recordatorios y ventanas de entrega se
          configuran en{" "}
          <a
            href="/settings?view=proactivity&section=delivery-policies"
            className="font-medium text-blue-700 underline dark:text-blue-300"
          >
            Ajustes → Proactividad → Políticas de entrega
          </a>
          . No dependen de la plantilla seleccionada.
        </p>
        <BfcacheRecoveryBoundary>
          <OperationalCaseTypesClient
            initialCaseTypes={caseTypes}
            initialOperationalCases={operationalCases}
            initialLatestEventsByCaseId={latestEventsByCaseId}
            initialSkillSummaries={skillSummaries}
            initialLabDefinitionOptions={labDefinitionOptions}
          />
        </BfcacheRecoveryBoundary>
      </div>
    </AppShell>
  );
}

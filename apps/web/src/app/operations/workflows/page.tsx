/**
 * Workflow Studio — catálogo (shell 2.7, absorbido por el Studio 4.2-4).
 *
 * Catálogo de definiciones resueltas para el tenant: globales + privadas
 * propias, JAMÁS privadas de otros tenants (2.7-6). Agrupa versiones por
 * familia, oculta fixtures de soak por defecto y ofrece fork/discard seguros.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  countPinnedActiveCasesByDefinition,
  createServerClient,
  getOperationalCaseTypeForUser,
  listWorkflowDefinitionsVisibleToUser,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import type { WorkflowDefinition } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import {
  filterCatalogDefinitions,
  groupDefinitionFamilies,
  toDefinitionCatalogRow,
  type DefinitionFamily,
} from "@/lib/workflow-studio/definition-catalog";
import {
  applyGraphOnlyStepFallbacks,
  emptyHelpCatalog,
  helpCatalogFromFlow,
  mergeSkillRegistryHelp,
  withRootSkill,
  type DefinitionHelpCatalog,
} from "@/lib/workflow-studio/definition-help";
import { WorkflowStudioTabs } from "./studio-tabs";
import { DefinitionDetail } from "./definition-detail";

export const dynamic = "force-dynamic";

function FamilyCard({
  family,
  catalogQuery,
}: {
  family: DefinitionFamily;
  catalogQuery: string;
}) {
  const draftHint =
    family.draftCount > 0
      ? family.draftCount === 1
        ? " · 1 borrador"
        : ` · ${family.draftCount} borradores`
      : "";
  return (
    <Link
      href={`/operations/workflows?definition=${family.head.id}${catalogQuery}`}
      className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-sm transition hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-700"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-neutral-900 dark:text-neutral-100">
          {family.title}
        </p>
        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {family.headStatusLabel}
        </span>
      </div>
      <p className="mt-1 text-neutral-500">
        {family.scopeLabel} · v{family.head.version}
        {family.head.status === "published" ? " vigente" : ""}
        {draftHint}
      </p>
      <p className="mt-1 text-neutral-500">{family.pinnedLabel}</p>
      {family.lineage ? (
        <p className="mt-1 text-neutral-400">{family.lineage}</p>
      ) : null}
    </Link>
  );
}

function FamilySection({
  title,
  families,
  catalogQuery,
}: {
  title: string;
  families: DefinitionFamily[];
  catalogQuery: string;
}) {
  if (families.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {families.map((family) => (
          <FamilyCard
            key={family.key}
            family={family}
            catalogQuery={catalogQuery}
          />
        ))}
      </div>
    </section>
  );
}

export default async function WorkflowStudioCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    definition?: string;
    tests?: string;
    error?: string;
    notice?: string;
  }>;
}) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const showTests = sp.tests === "1";
  const catalogQuery = showTests ? "&tests=1" : "";
  const catalogHref = showTests
    ? "/operations/workflows?tests=1"
    : "/operations/workflows";
  const db = createServerClient();

  let definitions: WorkflowDefinition[] = [];
  let pinnedCounts: Record<string, number> = {};
  let unavailable = false;
  try {
    [definitions, pinnedCounts] = await Promise.all([
      listWorkflowDefinitionsVisibleToUser(db, user.id),
      countPinnedActiveCasesByDefinition(db, user.id),
    ]);
  } catch {
    unavailable = true;
  }

  const visibleForCatalog = filterCatalogDefinitions(definitions, { showTests });
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const families = groupDefinitionFamilies(visibleForCatalog, pinnedCounts);
  const ownFamilies = families.filter((family) => family.ownerScope === "user");
  const globalFamilies = families.filter(
    (family) => family.ownerScope === "global"
  );
  const otherFamilies = families.filter(
    (family) =>
      family.ownerScope !== "user" && family.ownerScope !== "global"
  );

  // El detalle solo resuelve ids ya visibles para el tenant — nunca se
  // consulta un id arbitrario (2.7-6). Incluye soak aunque esté filtrado
  // del listado, si el usuario llega con ?definition=… (p. ej. link directo).
  const selected = sp.definition
    ? definitions.find((definition) => definition.id === sp.definition)
    : undefined;
  const selectedRow = selected
    ? toDefinitionCatalogRow(selected, pinnedCounts, { byId })
    : undefined;
  const selectedSiblings = selected
    ? (groupDefinitionFamilies(
        filterCatalogDefinitions(
          definitions.filter(
            (definition) =>
              definition.case_type === selected.case_type &&
              definition.owner_scope === selected.owner_scope &&
              definition.user_id === selected.user_id
          ),
          // En detalle de soak, mostrar hermanas soak aunque el listado las oculte.
          { showTests: true }
        ),
        pinnedCounts
      )[0]?.versions ?? [selected])
    : [];

  const hiddenTestCount = definitions.filter(
    (definition) =>
      definition.case_type === "work_plane_soak_synthetic"
  ).length;

  let help: DefinitionHelpCatalog = emptyHelpCatalog();
  if (selected && !unavailable) {
    try {
      const [caseType, registry] = await Promise.all([
        getOperationalCaseTypeForUser(db, user.id, selected.case_type),
        getSkillRegistryForUser(db, user.id).catch(() => null),
      ]);
      const skillSources =
        registry?.list().map((skill) => ({
          name: skill.name,
          description: skill.description,
          includes: skill.includes,
        })) ?? [];
      help = helpCatalogFromFlow(caseType?.operational_flow_jsonb);
      help = applyGraphOnlyStepFallbacks(help, selected.graph_jsonb);
      help = mergeSkillRegistryHelp(help, skillSources);
      help = withRootSkill(
        help,
        caseType?.default_skill_slug,
        skillSources
      );
    } catch {
      help = emptyHelpCatalog();
    }
  }

  return (
    <AppShell
      title="Diseño de flujos"
      description="Catálogo de definiciones de workflow: globales y privadas de tu cuenta."
    >
      <WorkflowStudioTabs active="catalog" />

      {!unavailable && !selected ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <p>
            Una tarjeta por flujo; las versiones se eligen en el detalle.
          </p>
          {hiddenTestCount > 0 || showTests ? (
            <Link
              href={
                showTests
                  ? "/operations/workflows"
                  : "/operations/workflows?tests=1"
              }
              className="font-semibold text-violet-700 underline dark:text-violet-300"
            >
              {showTests
                ? "Ocultar definiciones de prueba"
                : "Mostrar definiciones de prueba"}
            </Link>
          ) : null}
        </div>
      ) : null}

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El catálogo de definiciones no está disponible en este entorno.
        </div>
      ) : selected && selectedRow ? (
        <div className="space-y-3">
          <Link
            href={catalogHref}
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver al catálogo
          </Link>
          <DefinitionDetail
            definition={selected}
            row={selectedRow}
            siblings={selectedSiblings}
            byId={byId}
            viewerUserId={user.id}
            catalogQuery={catalogQuery}
            help={help}
            error={sp.error}
            notice={sp.notice}
          />
        </div>
      ) : families.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No hay definiciones de workflow publicadas ni en borrador todavía.
          {hiddenTestCount > 0 && !showTests ? (
            <span>
              {" "}
              Hay definiciones de prueba ocultas —{" "}
              <Link
                href="/operations/workflows?tests=1"
                className="font-semibold underline"
              >
                mostrarlas
              </Link>
              .
            </span>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          <FamilySection
            title="Mis flujos"
            families={ownFamilies}
            catalogQuery={catalogQuery}
          />
          <FamilySection
            title="Plantillas globales"
            families={globalFamilies}
            catalogQuery={catalogQuery}
          />
          <FamilySection
            title="Otras"
            families={otherFamilies}
            catalogQuery={catalogQuery}
          />
        </div>
      )}
    </AppShell>
  );
}

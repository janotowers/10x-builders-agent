/**
 * Workflow Studio — Diseño (Slice 4.2-4; Technical Plan §15/§16).
 *
 * Flujo del operador: describir → (aclarar) → spec de negocio → spec de
 * implementación → capability map con gaps en palabras del cliente →
 * validación §5.4 → simulación → publicar (acto humano, §10.5).
 *
 * La validación se calcula EN VIVO al renderizar (los catálogos del tenant
 * cambian: subir un asset o conectar una integración actualiza los gaps sin
 * tocar la definición). "Validar" y "Publicar" re-corren los gates en el
 * server y registran evidencia por gate contra el definition_hash.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  createServerClient,
  listEvidenceForSubject,
  listWorkflowDefinitionsVisibleToUser,
} from "@agents/db";
import type { WorkflowDefinition } from "@agents/types";
import {
  businessSpecSchema,
  implementationSpecSchema,
  specIsPresent,
  type CompilerGateName,
} from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import {
  filterCatalogDefinitions,
  formatEvidenceSeal,
  friendlyCaseTypeLabel,
  isInternalTestDefinition,
  shortDefinitionHash,
} from "@/lib/workflow-studio/definition-catalog";
import { validateDefinitionForUser } from "@/lib/workflow-studio/definition-validation";
import { WorkflowStudioTabs } from "../studio-tabs";
import { publishDefinitionAction, validateDefinitionAction } from "../actions";
import { CompileForm } from "./compile-form";

export const dynamic = "force-dynamic";

const GATE_LABELS: Record<CompilerGateName, string> = {
  spec_schema: "Especificaciones válidas",
  graph_schema: "Estructura del grafo",
  acyclicity: "Sin ciclos",
  reachability: "Todos los estados alcanzables",
  capability_resolution: "Capacidades resueltas",
  permission_validation: "Permisos de herramientas",
  credential_shape: "Sin credenciales embebidas",
  simulation: "Simulación de casos",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  validated: "Validado",
  published: "Publicado",
  deprecated: "Retirado",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      <div className="mt-2 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
        {children}
      </div>
    </section>
  );
}

function BusinessSpecView({ value }: { value: unknown }) {
  if (!specIsPresent(value)) {
    return (
      <p className="text-neutral-400">
        Sin especificación de negocio (definición anterior al compilador).
      </p>
    );
  }
  const parsed = businessSpecSchema.safeParse(value);
  if (!parsed.success) {
    return (
      <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-[10px] dark:bg-neutral-950">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  const spec = parsed.data;
  return (
    <div className="space-y-2">
      <p className="font-semibold">{spec.title}</p>
      <p>
        <span className="text-neutral-500">Objetivo:</span> {spec.objective}
      </p>
      <p>
        <span className="text-neutral-500">Actores:</span>{" "}
        {spec.actors.join(", ")}
      </p>
      <div>
        <p className="text-neutral-500">Camino feliz:</p>
        <ol className="list-decimal pl-4">
          {spec.happy_path.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      {spec.decisions.length > 0 ? (
        <p>
          <span className="text-neutral-500">Decisiones humanas:</span>{" "}
          {spec.decisions
            .map((decision) => `${decision.name} (${decision.approver})`)
            .join("; ")}
        </p>
      ) : null}
      <p>
        <span className="text-neutral-500">Resultados:</span>{" "}
        {spec.outcomes.join("; ")}
      </p>
      {spec.acceptance_scenarios.length > 0 ? (
        <div>
          <p className="text-neutral-500">Escenarios de aceptación:</p>
          <ul className="list-disc pl-4">
            {spec.acceptance_scenarios.map((scenario) => (
              <li key={scenario.name}>
                <span className="font-medium">{scenario.name}:</span> dado{" "}
                {scenario.given}, cuando {scenario.when}, entonces {scenario.then}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {spec.unimplementable_notes.length > 0 ? (
        <div className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Pendiente de implementar:</p>
          <ul className="list-disc pl-4">
            {spec.unimplementable_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-neutral-400">
          Descripción original
        </summary>
        <p className="mt-1 whitespace-pre-wrap text-neutral-500">
          {spec.description_nl}
        </p>
      </details>
    </div>
  );
}

function ImplementationSpecView({ value }: { value: unknown }) {
  if (!specIsPresent(value)) {
    return (
      <p className="text-neutral-400">
        Sin especificación de implementación (definición anterior al compilador).
      </p>
    );
  }
  const parsed = implementationSpecSchema.safeParse(value);
  if (!parsed.success) {
    return (
      <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-[10px] dark:bg-neutral-950">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  const spec = parsed.data;
  return (
    <div className="space-y-1">
      <p>{spec.summary}</p>
      <p>
        <span className="text-neutral-500">Estados:</span>{" "}
        {spec.states.map((state) => state.key).join(" → ")}
      </p>
      {spec.skills.length > 0 ? (
        <p>
          <span className="text-neutral-500">Skills:</span>{" "}
          {spec.skills.join(", ")}
        </p>
      ) : null}
      {spec.capabilities.length > 0 ? (
        <p>
          <span className="text-neutral-500">Capacidades:</span>{" "}
          {spec.capabilities.map((c) => c.capability).join(", ")}
        </p>
      ) : null}
      {spec.integrations.length > 0 ? (
        <p>
          <span className="text-neutral-500">Integraciones:</span>{" "}
          {spec.integrations.join(", ")}
        </p>
      ) : null}
      {spec.open_questions.length > 0 ? (
        <div className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Preguntas abiertas:</p>
          <ul className="list-disc pl-4">
            {spec.open_questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

async function DraftDetail({
  definition,
  userId,
  gatesError,
  existingForkNotice,
}: {
  definition: WorkflowDefinition;
  userId: string;
  gatesError: boolean;
  existingForkNotice: boolean;
}) {
  const db = createServerClient();
  const [report, evidence] = await Promise.all([
    validateDefinitionForUser(db, { userId, definition }),
    listEvidenceForSubject(db, {
      userId,
      subjectKind: "workflow_definition",
      subjectId: definition.id,
      limit: 16,
    }).catch(() => []),
  ]);
  const editable =
    definition.status === "draft" || definition.status === "validated";
  const backlogGaps = report.capabilityMap?.gaps.filter((g) => !g.blocking) ?? [];
  const blockingGaps = report.capabilityMap?.blockingGaps ?? [];

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">
            {friendlyCaseTypeLabel(definition.case_type)} · v
            {definition.version}
          </h2>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {STATUS_LABELS[definition.status] ?? definition.status}
          </span>
          <code className="text-[10px] text-neutral-500">
            {shortDefinitionHash(definition.definition_hash)}…
          </code>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Tipo: {definition.case_type}
          {definition.derived_from_definition_id
            ? ` · fork de v${definition.derived_from_version}`
            : ""}
        </p>
        {editable ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <form action={validateDefinitionAction}>
              <input type="hidden" name="definition_id" value={definition.id} />
              <button
                type="submit"
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
              >
                Validar y registrar evidencia
              </button>
            </form>
            <form action={publishDefinitionAction}>
              <input type="hidden" name="definition_id" value={definition.id} />
              <button
                type="submit"
                disabled={!report.ok}
                title={
                  report.ok
                    ? "Publicar esta versión (inmutable después)"
                    : "Los gates deben pasar antes de publicar"
                }
                className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Publicar
              </button>
            </form>
            <p className="text-[10px] text-neutral-400">
              Publicar re-ejecuta todos los gates y deja evidencia; una versión
              publicada es inmutable.
            </p>
          </div>
        ) : null}
        {gatesError ? (
          <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            No se publicó: uno o más gates fallaron. Revisa los resultados de
            validación abajo.
          </p>
        ) : null}
        {existingForkNotice ? (
          <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Ya tenías un borrador idéntico a esa plantilla; se abrió el existente
            en lugar de crear otro.
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Especificación de negocio">
          <BusinessSpecView value={definition.business_spec_jsonb} />
        </Section>

        <Section title="Especificación de implementación">
          <ImplementationSpecView value={definition.implementation_spec_jsonb} />
        </Section>

        <Section title="Capacidades y pendientes">
          {report.capabilityMap === null ? (
            <p className="text-neutral-400">
              El grafo no parsea; corrige la estructura primero.
            </p>
          ) : (
            <>
              {blockingGaps.length === 0 && backlogGaps.length === 0 ? (
                <p className="text-emerald-700 dark:text-emerald-300">
                  Todas las capacidades del flujo están resueltas en esta
                  cuenta.
                </p>
              ) : null}
              {blockingGaps.map((gap) => (
                <p
                  key={`${gap.kind}:${gap.key}`}
                  className="rounded bg-red-50 p-2 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                >
                  {gap.customerMessage}
                </p>
              ))}
              {backlogGaps.map((gap) => (
                <p
                  key={`${gap.kind}:${gap.key}`}
                  className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {gap.customerMessage}{" "}
                  {gap.linkHint === "assets_panel" ? (
                    <Link
                      href="/operations/workflows/assets"
                      className="font-semibold underline"
                    >
                      Ir a recursos
                    </Link>
                  ) : gap.linkHint === "integrations_panel" ? (
                    <Link
                      href="/settings?view=integrations&section=connections"
                      className="font-semibold underline"
                    >
                      Ir a integraciones
                    </Link>
                  ) : null}
                </p>
              ))}
              <p className="pt-1 text-[10px] text-neutral-400">
                Los pendientes en ámbar no bloquean la publicación: son la
                lista de trabajo de la cuenta.
              </p>
            </>
          )}
        </Section>

        <Section title="Validación">
          <p className="mb-2 text-[10px] text-neutral-400">
            Estado en vivo (se actualiza si cambian recursos o catálogos).
          </p>
          {report.gates.map((gate) => (
            <div key={gate.gate} className="flex items-start gap-2">
              <span
                className={
                  gate.result === "pass"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }
              >
                {gate.result === "pass" ? "✓" : "✗"}
              </span>
              <div>
                <p>{GATE_LABELS[gate.gate] ?? gate.gate}</p>
                {gate.result === "fail" &&
                Array.isArray(gate.detail.failures) ? (
                  <ul className="list-disc pl-4 text-[10px] text-red-600 dark:text-red-400">
                    {(gate.detail.failures as string[]).map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ))}
          {(() => {
            const latestAt =
              evidence.length > 0
                ? evidence.reduce(
                    (latest, record) =>
                      record.created_at > latest ? record.created_at : latest,
                    evidence[0]!.created_at
                  )
                : null;
            const seal = formatEvidenceSeal({
              evidenceCount: evidence.length,
              gateCount: report.gates.length,
              latestAt,
              shortHash: shortDefinitionHash(definition.definition_hash),
            });
            return seal ? (
              <p className="mt-3 rounded-md bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                Evidencia: {seal}
              </p>
            ) : (
              <p className="mt-3 text-[10px] text-neutral-400">
                Aún no hay evidencia sellada. Usa «Validar y registrar
                evidencia» para dejar constancia.
              </p>
            );
          })()}
        </Section>

        <Section title="Simulación">
          {report.simulationOutcomes.length === 0 ? (
            <p className="text-neutral-400">Sin escenarios simulables.</p>
          ) : (
            report.simulationOutcomes.map((outcome) => (
              <div key={outcome.scenario}>
                <p>
                  {outcome.ok ? "✓" : "✗"} <code>{outcome.scenario}</code> —
                  terminal <code>{outcome.terminalStep ?? "∅"}</code>
                  {outcome.ok
                    ? ""
                    : ` (esperado ${outcome.expectedTerminalStep ?? "∅"})`}
                </p>
                {outcome.divergences.map((divergence, index) => (
                  <p
                    key={index}
                    className="pl-4 text-[10px] text-red-600 dark:text-red-400"
                  >
                    {divergence.from ?? "∅"} → {divergence.to}: {divergence.verdict}
                    {divergence.failedGuards.length > 0
                      ? ` · guards: ${divergence.failedGuards.join(", ")}`
                      : ""}
                  </p>
                ))}
              </div>
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

export default async function WorkflowDesignPage({
  searchParams,
}: {
  searchParams: Promise<{
    definition?: string;
    error?: string;
    notice?: string;
    tests?: string;
  }>;
}) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const showTests = sp.tests === "1";
  const designListHref = showTests
    ? "/operations/workflows/design?tests=1"
    : "/operations/workflows/design";
  const db = createServerClient();

  let visible: WorkflowDefinition[] = [];
  let unavailable = false;
  try {
    visible = await listWorkflowDefinitionsVisibleToUser(db, user.id);
  } catch {
    unavailable = true;
  }

  const ownAll = visible.filter((definition) => definition.user_id === user.id);
  const own = filterCatalogDefinitions(ownAll, { showTests });
  const statusRank = (status: string) =>
    status === "draft" ? 0 : status === "validated" ? 1 : 2;
  own.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      b.version - a.version ||
      b.created_at.localeCompare(a.created_at)
  );
  const knownCaseTypes = [
    ...new Set(
      visible
        .filter((definition) => !isInternalTestDefinition(definition))
        .map((d) => d.case_type)
    ),
  ].sort();
  const hiddenTestCount = ownAll.filter(isInternalTestDefinition).length;

  // Solo definiciones propias se abren en Diseño (las globales se forkean
  // desde el catálogo). Incluye soak si llega por ?definition=… directo.
  const selected = sp.definition
    ? ownAll.find((definition) => definition.id === sp.definition)
    : undefined;

  return (
    <AppShell
      title="Diseño de flujos"
      description="Describe un flujo, revisa la especificación y el borrador, resuelve pendientes y publica con evidencia."
    >
      <WorkflowStudioTabs active="design" />

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El diseño de flujos no está disponible en este entorno.
        </div>
      ) : selected ? (
        <div className="space-y-3">
          <Link
            href={designListHref}
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver a mis definiciones
          </Link>
          <DraftDetail
            definition={selected}
            userId={user.id}
            gatesError={sp.error === "gates"}
            existingForkNotice={sp.notice === "existing_fork"}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <CompileForm knownCaseTypes={knownCaseTypes} />

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Mis definiciones</h3>
              {hiddenTestCount > 0 || showTests ? (
                <Link
                  href={
                    showTests
                      ? "/operations/workflows/design"
                      : "/operations/workflows/design?tests=1"
                  }
                  className="text-xs font-semibold text-violet-700 underline dark:text-violet-300"
                >
                  {showTests
                    ? "Ocultar definiciones de prueba"
                    : "Mostrar definiciones de prueba"}
                </Link>
              ) : null}
            </div>
            {own.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                {hiddenTestCount > 0 && !showTests ? (
                  <>
                    Solo hay definiciones de prueba ocultas.{" "}
                    <Link
                      href="/operations/workflows/design?tests=1"
                      className="font-semibold underline"
                    >
                      Mostrarlas
                    </Link>{" "}
                    o compila un flujo nuevo / crea una versión propia desde el
                    catálogo.
                  </>
                ) : (
                  <>
                    Aún no tienes definiciones propias. Compila una desde una
                    descripción o crea una versión propia (fork) desde el
                    catálogo.
                  </>
                )}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {own.map((definition) => (
                  <Link
                    key={definition.id}
                    href={`/operations/workflows/design?definition=${definition.id}${
                      showTests ? "&tests=1" : ""
                    }`}
                    className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-sm transition hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-700"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-neutral-900 dark:text-neutral-100">
                        {friendlyCaseTypeLabel(definition.case_type)} · v
                        {definition.version}
                      </p>
                      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {STATUS_LABELS[definition.status] ?? definition.status}
                      </span>
                    </div>
                    <p className="mt-1 text-neutral-500">{definition.case_type}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <p className="text-[10px] text-neutral-400">
            ¿Buscas los diagnósticos del laboratorio de plantillas (pruebas E2E,
            herramientas por paso)?{" "}
            <Link
              href="/settings/operational-case-types"
              className="font-semibold underline"
            >
              Laboratorio de plantillas
            </Link>
          </p>
        </div>
      )}
    </AppShell>
  );
}

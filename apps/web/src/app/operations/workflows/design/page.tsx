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
import type { ReactNode } from "react";
import {
  createServerClient,
  getAccountSkill,
  getDurableTask,
  getStudioAuthoringSession,
  listAccountSkillsForUser,
  listDurableTasksForUser,
  listEvidenceForSubject,
  listOperationalCaseTypesForUser,
  listScheduledTasks,
  listWorkflowDefinitionsVisibleToUser,
  type ScheduledTask,
} from "@agents/db";
import type {
  AccountSkill,
  DurableTask,
  StudioAuthoringSession,
  WorkflowDefinition,
} from "@agents/types";
import {
  businessSpecSchema,
  durableTaskSpecSchema,
  implementationSpecSchema,
  specIsPresent,
  type CompilerGateName,
} from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getGlobalSkillRegistry } from "@agents/agent";
import {
  definitionLifecycleLabel,
  filterCatalogDefinitions,
  formatEvidenceSeal,
  friendlyCaseTypeLabel,
  groupDefinitionFamilies,
  isInternalTestDefinition,
  shortDefinitionHash,
} from "@/lib/workflow-studio/definition-catalog";
import { validateDefinitionForUser } from "@/lib/workflow-studio/definition-validation";
import {
  STUDIO_KIND_BADGE,
  buildStudioInventory,
  type StudioArtifactCard,
} from "@/lib/workflow-studio/studio-inventory";
import {
  accountSkillProvenanceLabel,
  buildSkillUsageIndex,
  classifyAccountSkillProvenance,
  formatSkillStudioUsageLabel,
} from "@/lib/skill-provenance";
import { WorkflowStudioTabs } from "../studio-tabs";
import {
  publishDefinitionAction,
  startDurableTaskRunAction,
  validateDefinitionAction,
} from "../actions";
import { CompileForm } from "./compile-form";
import { OperationalAiTestPanel } from "./operational-ai-test-panel";

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
  fidelity: "Fidelidad a la descripción",
};

const DURABLE_TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  active: "Activa",
  paused: "Pausada",
  completed: "Completada",
  cancelled: "Cancelada",
  failed: "Fallida",
};

function formatUpdatedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-MX", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function DurableTaskDetail({
  task,
  schedule,
}: {
  task: DurableTask;
  schedule?: ScheduledTask | null;
}) {
  const parsed = durableTaskSpecSchema.safeParse(task.spec_jsonb);
  const spec = parsed.success ? parsed.data : null;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">{task.title}</h2>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {DURABLE_TASK_STATUS_LABELS[task.status] ?? task.status}
          </span>
        </div>
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
          {task.objective}
        </p>
        <p className="mt-2 text-[10px] text-neutral-400">
          Actualizada {formatUpdatedAt(task.updated_at)}
        </p>
      </div>
      <OperationalAiTestPanel
        artifactKind={schedule ? "schedule" : "durable_task"}
        artifactId={schedule?.id ?? task.id}
      />
      {spec ? (
        <>
          {schedule ? (
            <Section title="Programación">
              <p>
                {schedule.cron_expr
                  ? `Recurrencia ${schedule.cron_expr}`
                  : schedule.schedule_type}
                {" · "}
                {schedule.timezone}
              </p>
              <p className="text-[10px] text-neutral-400">
                Próxima ejecución: {schedule.next_run_at ?? "por calcular"}
              </p>
            </Section>
          ) : null}
          <Section title="Criterios de aceptación">
            <ul className="list-disc space-y-1 pl-4">
              {spec.acceptance_criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </Section>
          <Section title="Datos y requisitos">
            {spec.input_requirements.length === 0 ? (
              <p className="text-neutral-400">No requiere datos adicionales.</p>
            ) : (
              <ul className="space-y-1">
                {spec.input_requirements.map((requirement) => (
                  <li key={`${requirement.kind}:${requirement.key}`}>
                    <span className="font-medium">{requirement.label}</span>
                    <span className="text-neutral-400">
                      {" "}
                      · {requirement.kind}
                      {requirement.required === false ? " · opcional" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Unidades de trabajo">
            <ol className="list-decimal space-y-1 pl-4">
              {spec.work_templates.map((template) => (
                <li key={template.work_type}>
                  <span className="font-medium">{template.objective}</span>
                  <span className="text-neutral-400">
                    {" "}
                    · {template.required_capability}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Resultado">
            <p>{spec.result_contract.description}</p>
            <p className="text-[10px] text-neutral-400">
              Campos: {spec.result_contract.required_keys.join(", ")}
            </p>
          </Section>
          {task.status === "draft" || task.status === "active" ? (
            <form
              action={startDurableTaskRunAction}
              className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-xs dark:border-violet-900 dark:bg-violet-950/30"
            >
              <input type="hidden" name="durable_task_id" value={task.id} />
              <label className="block font-medium" htmlFor="run_input_json">
                Datos para esta ejecución
              </label>
              <textarea
                id="run_input_json"
                name="run_input_json"
                rows={4}
                className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-950"
                placeholder='{"clave": "valor"}'
                defaultValue="{}"
              />
              <p className="mt-1 text-[10px] text-neutral-500">
                Usa las claves mostradas arriba. El inicio es explícito: compilar
                nunca ejecuta por sí solo.
              </p>
              <button
                type="submit"
                className="mt-3 rounded-lg bg-violet-700 px-3 py-2 font-semibold text-white hover:bg-violet-800"
              >
                {task.schedule_ref ? "Ejecutar ahora" : "Activar y ejecutar"}
              </button>
            </form>
          ) : null}
        </>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Esta tarea es anterior al contrato durable ejecutable. Vuelve a
          compilarla para poder ejecutarla.
        </div>
      )}
    </div>
  );
}

function AccountSkillDetail({ skill }: { skill: AccountSkill }) {
  const allowedTools = Array.isArray(skill.metadata_jsonb.allowed_tools)
    ? skill.metadata_jsonb.allowed_tools
    : [];
  const includes = Array.isArray(skill.metadata_jsonb.includes)
    ? skill.metadata_jsonb.includes
    : [];
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold">
            {String(skill.metadata_jsonb.display_title ?? skill.slug)}
          </h2>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {skill.status === "draft" ? "Borrador" : "Activa"}
          </span>
        </div>
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
          {String(skill.metadata_jsonb.description ?? "")}
        </p>
        <p className="mt-2 text-[10px] text-neutral-400">
          {skill.slug} · v{skill.version} · actualizada{" "}
          {formatUpdatedAt(skill.updated_at)}
        </p>
      </div>
      <OperationalAiTestPanel
        artifactKind="reusable_skill"
        artifactId={skill.id}
      />
      <Section title="Capacidades y composición">
        <p>
          Herramientas:{" "}
          {allowedTools.length > 0 ? allowedTools.join(", ") : "ninguna"}
        </p>
        <p>
          Incluye: {includes.length > 0 ? includes.join(", ") : "ningún skill"}
        </p>
      </Section>
      <details className="rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        <summary className="cursor-pointer font-semibold">
          Ver SKILL.md generado
        </summary>
        <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-950 p-3 text-[10px] text-neutral-100">
          {skill.body_md}
        </pre>
      </details>
      <Link
        href={`/settings/account-skills?slug=${encodeURIComponent(skill.slug)}`}
        className="inline-block rounded-lg border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        Abrir editor avanzado
      </Link>
    </div>
  );
}

function AuthoringReviewShell({
  session,
  kindLabel,
  children,
}: {
  session: StudioAuthoringSession | null;
  kindLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {session ? (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Borrador creado</h2>
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800 dark:bg-violet-900 dark:text-violet-100">
              {kindLabel}
            </span>
          </div>
          <p className="mt-2 text-xs text-neutral-700 dark:text-neutral-200">
            {session.description_nl}
          </p>
          <p className="mt-2 text-[10px] text-neutral-500">
            Revisa el resultado general. Editar, validar, publicar, activar o
            ejecutar son acciones humanas posteriores.
          </p>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function StudioArtifactsList({
  items,
  emptyHint,
}: {
  items: StudioArtifactCard[];
  emptyHint: ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        {emptyHint}
      </div>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        const badge = STUDIO_KIND_BADGE[item.kind];
        return (
          <Link
            key={`${item.kind}:${item.id}`}
            href={item.href}
            className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-sm transition hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-700"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-semibold text-neutral-900 dark:text-neutral-100">
                {item.title}
              </p>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}
              >
                {badge.label}
              </span>
            </div>
            <p className="mt-1 text-neutral-500">{item.subtitle}</p>
            {item.provenanceLabel ? (
              <p className="mt-1 text-[10px] text-neutral-400">
                {item.provenanceLabel}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-neutral-400">
              <span>{item.statusLabel}</span>
              <span>Actualizado {formatUpdatedAt(item.updatedAt)}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

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
  siblings,
  gatesError,
  existingForkNotice,
}: {
  definition: WorkflowDefinition;
  userId: string;
  siblings: WorkflowDefinition[];
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
  const lifecycleLabel = definitionLifecycleLabel(definition, siblings);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">
            {friendlyCaseTypeLabel(definition.case_type)} · v
            {definition.version}
          </h2>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {lifecycleLabel}
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
        <p className="mt-1 text-[10px] text-neutral-400">
          Los casos nuevos usan la versión vigente de mayor número; los
          existentes conservan su pin.
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

      <OperationalAiTestPanel
        artifactKind="case_workflow"
        artifactId={definition.id}
      />

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
                    {divergence.reason
                      ? ` · ${divergence.reason}`
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
    durable_task?: string;
    account_skill?: string;
    authoring_session?: string;
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

  let durableTasks: DurableTask[] = [];
  let accountSkills: AccountSkill[] = [];
  let scheduledTasks: ScheduledTask[] = [];
  let selectedDurableTask: DurableTask | null = null;
  let selectedAccountSkill: AccountSkill | null = null;
  let authoringSession: StudioAuthoringSession | null = null;
  try {
    if (sp.durable_task) {
      selectedDurableTask = await getDurableTask(
        db,
        user.id,
        sp.durable_task
      );
    }
    durableTasks = await listDurableTasksForUser(db, user.id, {
      limit: 48,
    });
  } catch {
    // Entorno aún sin las migraciones durable: la lista queda vacía.
  }
  try {
    accountSkills = await listAccountSkillsForUser(db, user.id, {
      statuses: ["draft", "active"],
    });
    if (sp.account_skill) {
      selectedAccountSkill = await getAccountSkill(
        db,
        user.id,
        sp.account_skill
      );
    }
  } catch {
    // Skills de cuenta ausentes en el entorno.
  }
  try {
    scheduledTasks = (await listScheduledTasks(db, user.id)).filter(
      (task) => Boolean(task.durable_task_id)
    );
  } catch {
    // Schedules ausentes o sin columna durable_task_id.
  }
  if (sp.authoring_session) {
    try {
      authoringSession = await getStudioAuthoringSession(
        db,
        user.id,
        sp.authoring_session
      );
    } catch {
      authoringSession = null;
    }
  }

  const ownAll = visible.filter((definition) => definition.user_id === user.id);
  const own = filterCatalogDefinitions(ownAll, { showTests });
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
  const selectedFamily =
    selected != null
      ? groupDefinitionFamilies(ownAll, {}).find((family) =>
          family.versions.some((version) => version.id === selected.id)
        )
      : undefined;

  let globalSkillSlugs: string[] = [];
  try {
    const globalRegistry = await getGlobalSkillRegistry();
    globalSkillSlugs = globalRegistry.list().map((skill) => skill.name);
  } catch {
    globalSkillSlugs = [];
  }

  let caseTypeRoots: Array<{ caseType: string; defaultSkillSlug: string }> =
    [];
  try {
    const caseTypes = await listOperationalCaseTypesForUser(db, user.id);
    caseTypeRoots = caseTypes
      .map((caseType) => ({
        caseType: caseType.case_type,
        defaultSkillSlug: (caseType.default_skill_slug ?? "").trim(),
      }))
      .filter((row) => row.defaultSkillSlug.length > 0);
  } catch {
    caseTypeRoots = [];
  }

  const skillUsage = buildSkillUsageIndex({
    definitions: own,
    caseTypeRoots,
  });
  const studioArtifacts = buildStudioInventory({
    ownDefinitions: ownAll,
    durableTasks,
    accountSkills,
    scheduledTasks,
    globalSkillSlugs,
    showTests,
  }).map((card) => {
    if (card.kind !== "reusable_skill") return card;
    const skill = accountSkills.find((item) => item.id === card.id);
    if (!skill) return card;
    const usage = formatSkillStudioUsageLabel(
      skillUsage.get(skill.slug),
      friendlyCaseTypeLabel
    );
    const provenance = classifyAccountSkillProvenance({
      slug: skill.slug,
      metadata: skill.metadata_jsonb,
      globalSkillSlugs,
    });
    return {
      ...card,
      provenanceKind: provenance,
      provenanceLabel: [
        accountSkillProvenanceLabel(provenance),
        usage,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  const selectedSchedule = selectedDurableTask
    ? scheduledTasks.find(
        (task) =>
          task.id === selectedDurableTask.schedule_ref ||
          task.durable_task_id === selectedDurableTask.id
      ) ?? null
    : null;
  const authoredKindLabel =
    authoringSession?.artifact_kind === "case_workflow"
      ? "Flujo de caso"
      : authoringSession?.artifact_kind === "durable_task"
        ? "Tarea durable"
        : authoringSession?.artifact_kind === "reusable_skill"
          ? "Skill reusable"
          : authoringSession?.artifact_kind === "schedule"
            ? "Programación"
            : "Creación de Studio";

  return (
    <AppShell
      title="Diseño"
      description="Describe lo que necesitas: Gu clasifica y produce el borrador (caso, tarea durable, skill o programación)."
    >
      <WorkflowStudioTabs active="design" />

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El diseño de flujos no está disponible en este entorno.
        </div>
      ) : selectedAccountSkill ? (
        <div className="space-y-3">
          <Link
            href={designListHref}
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver a mis creaciones
          </Link>
          <AuthoringReviewShell
            session={authoringSession}
            kindLabel={authoredKindLabel}
          >
            <AccountSkillDetail skill={selectedAccountSkill} />
          </AuthoringReviewShell>
        </div>
      ) : selectedDurableTask ? (
        <div className="space-y-3">
          {sp.error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
              {sp.error}
            </div>
          ) : null}
          <Link
            href={designListHref}
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver a mis creaciones
          </Link>
          <AuthoringReviewShell
            session={authoringSession}
            kindLabel={authoredKindLabel}
          >
            <DurableTaskDetail
              task={selectedDurableTask}
              schedule={selectedSchedule}
            />
          </AuthoringReviewShell>
        </div>
      ) : selected ? (
        <div className="space-y-3">
          <Link
            href={designListHref}
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver a mis creaciones
          </Link>
          <AuthoringReviewShell
            session={authoringSession}
            kindLabel={authoredKindLabel}
          >
            <DraftDetail
              definition={selected}
              userId={user.id}
              siblings={selectedFamily?.versions ?? [selected]}
              gatesError={sp.error === "gates"}
              existingForkNotice={sp.notice === "existing_fork"}
            />
          </AuthoringReviewShell>
        </div>
      ) : (
        <div className="space-y-4">
          <CompileForm knownCaseTypes={knownCaseTypes} />

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Mis creaciones</h3>
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
                    ? "Ocultar flujos de prueba"
                    : "Mostrar flujos de prueba"}
                </Link>
              ) : null}
            </div>
            <p className="mb-2 text-[10px] text-neutral-400">
              Solo contenido de esta cuenta. Las skills globales están en
              Capacidades disponibles (Ajustes).
            </p>
            <StudioArtifactsList
              items={studioArtifacts}
              emptyHint={
                hiddenTestCount > 0 && !showTests ? (
                  <>
                    Solo hay flujos de prueba ocultos.{" "}
                    <Link
                      href="/operations/workflows/design?tests=1"
                      className="font-semibold underline"
                    >
                      Mostrarlos
                    </Link>{" "}
                    o crea un borrador nuevo arriba.
                  </>
                ) : (
                  <>
                    Aún no hay creaciones. Describe arriba lo que necesitas:
                    puede ser un flujo de caso, una tarea durable, un skill o una
                    programación.
                  </>
                )
              }
            />
          </div>

          <div className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-sm font-semibold">Capacidades disponibles</h3>
            <p className="mt-1 text-neutral-500">
              Catálogo global y ajustes de la cuenta (no son creaciones tuyas).
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-violet-700 dark:text-violet-300">
              <li>
                <Link href="/operations/workflows" className="font-semibold underline">
                  Catálogo de flujos
                </Link>
              </li>
              <li>
                <Link
                  href="/settings?view=capabilities"
                  className="font-semibold underline"
                >
                  Skills globales en Ajustes
                </Link>
              </li>
              <li>
                <Link href="/settings/account-skills" className="font-semibold underline">
                  Skills de cuenta
                </Link>
              </li>
              <li>
                <Link
                  href="/settings?view=integrations&section=connections"
                  className="font-semibold underline"
                >
                  Integraciones
                </Link>
              </li>
            </ul>
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

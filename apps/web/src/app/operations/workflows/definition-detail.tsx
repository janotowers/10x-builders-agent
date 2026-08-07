import Link from "next/link";
import type { WorkflowDefinition } from "@agents/types";
import {
  approvalKindLabel,
  checkLabel,
  definitionStatusLabel,
  emptyWorkTemplatesMessage,
  evidenceInputLabel,
  friendlyCaseTypeLabel,
  guardLabel,
  happyPathStates,
  ownerScopeLabel,
  pinnedCasesLabel,
  resolveForkLineageLabel,
  stepSkillSummary,
  transitionSummary,
  type DefinitionCatalogRow,
} from "@/lib/workflow-studio/definition-catalog";
import {
  resolveSkillDescription,
  resolveSkillLabel,
  resolveSkillRoutingHint,
  resolveSkillTechnicalNotes,
  resolveStepDescription,
  studioLabelsEquivalent,
  type DefinitionHelpCatalog,
} from "@/lib/workflow-studio/definition-help";
import { ForkButton } from "./fork-button";
import { DiscardButton } from "./discard-button";
import { ExpandableItem } from "./expandable-item";
import { TechId } from "./tech-id";

function DetailSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {hint ? (
        <p className="mt-1 text-[10px] leading-relaxed text-neutral-400">
          {hint}
        </p>
      ) : null}
      <div className="mt-2 space-y-0.5 text-xs text-neutral-700 dark:text-neutral-300">
        {children}
      </div>
    </section>
  );
}

function StatusBadge({
  status,
}: {
  status: DefinitionCatalogRow["status"];
}) {
  const label = definitionStatusLabel(status);
  const tone =
    status === "published"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : status === "draft"
        ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : status === "validated"
          ? "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
          : "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function ScopeBadge({ scopeLabel, scope }: { scopeLabel: string; scope: string }) {
  const tone =
    scope === "user"
      ? "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200"
      : "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {scopeLabel}
    </span>
  );
}

function HelpText({ text }: { text: string | null }) {
  return (
    <p className={text ? "" : "text-neutral-400"}>
      {text ?? "Sin descripción disponible."}
    </p>
  );
}

type StudioKind =
  | "Estado"
  | "Condición"
  | "Verificación"
  | "Aprobación"
  | "Evidencia"
  | "Habilidad";

/**
 * Prefijo de kind + label amigable + id técnico.
 * Si el label ya empieza con el kind (“Aprobación de precio”), no lo duplica.
 */
function kindAwareLabel(kind: StudioKind, label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return `${kind}:`;
  if (new RegExp(`^${kind}\\b`, "i").test(trimmed)) return trimmed;
  return `${kind}: ${trimmed}`;
}

function KindWithTechId({
  kind,
  label,
  value,
}: {
  kind: StudioKind;
  label: string;
  value: string;
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-neutral-600 dark:text-neutral-300">
        {kindAwareLabel(kind, label)}
      </span>
      <TechId value={value} />
    </span>
  );
}

/** Descripción de skill: copy de operador + notas técnicas + routing. */
function SkillHelpText({
  summary,
  technicalNotes,
  routing,
}: {
  summary: string | null;
  technicalNotes?: string | null;
  routing: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <HelpText text={summary} />
      {technicalNotes ? (
        <p className="rounded-md bg-neutral-50 px-2 py-1.5 text-[10px] leading-relaxed text-neutral-500 dark:bg-neutral-950">
          <span className="font-semibold text-neutral-400">
            Detalle técnico (implementación):{" "}
          </span>
          {technicalNotes}
        </p>
      ) : null}
      {routing ? (
        <p className="rounded-md bg-neutral-50 px-2 py-1.5 text-[10px] leading-relaxed text-neutral-500 dark:bg-neutral-950">
          <span className="font-semibold text-neutral-400">
            Cuándo la selecciona el agente:{" "}
          </span>
          {routing}
        </p>
      ) : null}
    </div>
  );
}

export function DefinitionDetail({
  definition,
  row,
  siblings,
  byId,
  viewerUserId,
  catalogQuery,
  help,
  error,
  notice,
}: {
  definition: WorkflowDefinition;
  row: DefinitionCatalogRow;
  siblings: WorkflowDefinition[];
  byId: ReadonlyMap<string, WorkflowDefinition>;
  viewerUserId: string;
  /** Query string suffix for version links (e.g. "&tests=1"). */
  catalogQuery: string;
  help: DefinitionHelpCatalog;
  error?: string;
  /** Aviso post-acto (p. ej. "published" tras Publicar). */
  notice?: string;
}) {
  const graph = definition.graph_jsonb;
  const path = happyPathStates(graph);
  const transitions = transitionSummary(graph);
  const steps = stepSkillSummary(graph);
  const lineage = resolveForkLineageLabel(definition, byId);
  const isOwn =
    definition.owner_scope === "user" && definition.user_id === viewerUserId;
  const editable =
    isOwn &&
    (definition.status === "draft" || definition.status === "validated");
  const canFork = definition.status === "published";
  const labelByKey = new Map(path.map((state) => [state.key, state.label]));
  const highestPublishedVersion = siblings
    .filter((sibling) => sibling.status === "published")
    .reduce((max, sibling) => Math.max(max, sibling.version), 0);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <h2 className="text-sm font-semibold">
            {friendlyCaseTypeLabel(definition.case_type)}
          </h2>
          <TechId kind="Tipo" value={definition.workflow_key} />
          <span className="text-xs text-neutral-500">v{definition.version}</span>
          <StatusBadge status={definition.status} />
          <ScopeBadge
            scopeLabel={row.scopeLabel}
            scope={definition.owner_scope}
          />
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          <span
            className={
              row.pinnedActiveCases > 0
                ? "font-medium text-emerald-700 dark:text-emerald-300"
                : ""
            }
          >
            {row.pinnedLabel}
          </span>
          {lineage ? ` · ${lineage}` : ""}
        </p>

        {notice === "published" ? (
          <p className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            Acabas de publicar la v{definition.version}. Esta es la versión que
            acabas de dejar inmutable; otras versiones de la familia siguen
            listadas abajo.
          </p>
        ) : null}

        {siblings.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {siblings.map((sibling) => {
              const active = sibling.id === definition.id;
              const isCurrentPublished =
                sibling.status === "published" &&
                sibling.version === highestPublishedVersion;
              return (
                <Link
                  key={sibling.id}
                  href={`/operations/workflows?definition=${sibling.id}${catalogQuery}`}
                  className={`rounded-md px-2 py-1 text-[10px] font-medium ${
                    active
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-white text-neutral-600 ring-1 ring-neutral-200 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-800"
                  }`}
                >
                  v{sibling.version} {definitionStatusLabel(sibling.status)}
                  {isCurrentPublished ? " · vigente" : ""}
                </Link>
              );
            })}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canFork ? <ForkButton definitionId={definition.id} /> : null}
          {editable ? (
            <>
              <Link
                href={`/operations/workflows/design?definition=${definition.id}`}
                className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
              >
                Abrir en Diseño
              </Link>
              <DiscardButton definitionId={definition.id} />
            </>
          ) : null}
        </div>

        {error === "pinned" ? (
          <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            No se puede descartar: hay casos activos pineados a esta versión.
          </p>
        ) : null}
        {error === "not_draft" ? (
          <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            Solo se pueden descartar borradores o versiones validadas propias.
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <DetailSection
          title={`Pasos del flujo (${path.length})`}
          hint="Haz clic en un paso para ver su descripción."
        >
          <ol className="list-decimal space-y-0.5 pl-4">
            {path.map((state) => (
              <li key={state.key} className="pl-0.5">
                <ExpandableItem
                  summary={
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-medium">{state.label}</span>
                      {state.isTerminal ? (
                        <span className="rounded border border-emerald-300 bg-emerald-50 px-1 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                          Final
                        </span>
                      ) : null}
                      <TechId kind="Estado" value={state.key} />
                    </span>
                  }
                  details={
                    <>
                      <HelpText
                        text={resolveStepDescription(state.key, help)}
                      />
                      {state.isTerminal ? (
                        <p className="text-emerald-700 dark:text-emerald-300">
                          Este es un paso final del flujo.
                        </p>
                      ) : null}
                    </>
                  }
                />
              </li>
            ))}
          </ol>
        </DetailSection>

        <DetailSection
          title={`Transiciones (${transitions.length})`}
          hint="Indican cómo puede pasar el caso de un paso a otro y qué condiciones deben cumplirse."
        >
          {transitions.map((transition, index) => (
            <ExpandableItem
              key={`${transition.fromKey}-${transition.toKey}-${index}`}
              summary={
                <span>
                  <span className="font-medium">{transition.fromLabel}</span>
                  {" → "}
                  <span className="font-medium">{transition.toLabel}</span>
                  {transition.guardLabels.length > 0 ? (
                    <span className="ml-1.5 rounded border border-sky-300 bg-sky-50 px-1 py-0.5 text-[10px] text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                      Con condición
                    </span>
                  ) : null}
                  {transition.approvalRequired ? (
                    <span className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      Requiere aprobación
                    </span>
                  ) : null}
                </span>
              }
              details={
                <>
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-neutral-500">De</span>
                    <KindWithTechId
                      kind="Estado"
                      label={transition.fromLabel}
                      value={transition.fromKey}
                    />
                    <span className="text-neutral-500">a</span>
                    <KindWithTechId
                      kind="Estado"
                      label={transition.toLabel}
                      value={transition.toKey}
                    />
                  </p>
                  {transition.guards.length > 0 ? (
                    <div className="space-y-1">
                      <p className="font-medium text-neutral-500">Condiciones</p>
                      {transition.guards.map((guard) => (
                        <p key={guard}>
                          <KindWithTechId
                            kind="Condición"
                            label={guardLabel(guard)}
                            value={guard}
                          />
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-neutral-400">
                      Sin condiciones adicionales.
                    </p>
                  )}
                  {transition.approvalRequired ? (
                    <p>
                      <KindWithTechId
                        kind="Aprobación"
                        label={approvalKindLabel(transition.approvalRequired)}
                        value={transition.approvalRequired}
                      />
                    </p>
                  ) : null}
                </>
              }
            />
          ))}
        </DetailSection>

        <DetailSection
          title="Habilidades"
          hint="Primero la habilidad raíz del flujo; después las habilidades de cada paso. Haz clic para ver la descripción."
        >
          {help.rootSkill ? (
            <ExpandableItem
              summary={
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">Habilidad raíz</span>
                    <span className="rounded border border-violet-300 bg-violet-50 px-1 py-0.5 text-[10px] font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
                      Compuesta
                    </span>
                  </span>
                  <TechId kind="Habilidad" value={help.rootSkill.slug} />
                </span>
              }
              details={
                <>
                  <SkillHelpText
                    summary={help.rootSkill.description}
                    technicalNotes={help.rootSkill.technicalNotes}
                    routing={help.rootSkill.routingHint}
                  />
                  {help.rootSkill.includes.length > 0 ? (
                    <div className="space-y-1">
                      <p className="font-medium text-neutral-500">
                        Incluye estas habilidades de paso
                      </p>
                      {help.rootSkill.includes.map((slug) => (
                        <p key={slug}>
                          <TechId kind="Habilidad" value={slug} />
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-neutral-400">
                      No declara sub-habilidades (`includes`) en el registro.
                    </p>
                  )}
                </>
              }
            />
          ) : (
            <p className="mb-1 text-neutral-400">
              Este tipo de caso no declara una habilidad raíz
              (`default_skill_slug`).
            </p>
          )}

          <p className="pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Por paso
          </p>
          {steps.length === 0 ? (
            <p className="text-neutral-400">Sin habilidades de paso declaradas.</p>
          ) : (
            steps.map((step) => {
              const skillLabel = resolveSkillLabel(step.skill, help);
              const showSkillLabel =
                skillLabel != null &&
                !studioLabelsEquivalent(skillLabel, step.stateLabel);
              return (
                <ExpandableItem
                  key={step.stateKey}
                  summary={
                    <span className="flex flex-col gap-1">
                      <span className="font-medium">{step.stateLabel}</span>
                      {step.skill ? (
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-neutral-600 dark:text-neutral-300">
                            Habilidad
                            {showSkillLabel ? `: ${skillLabel}` : ":"}
                          </span>
                          <TechId value={step.skill} />
                          {step.bigqueryContext ? (
                            <span className="rounded border border-sky-300 bg-sky-50 px-1 py-0.5 text-[10px] text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                              Contexto BigQuery
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-neutral-400">
                          Habilidad: no asignada
                        </span>
                      )}
                    </span>
                  }
                  details={
                    <>
                      {step.skill ? (
                        <SkillHelpText
                          summary={resolveSkillDescription(step.skill, help)}
                          technicalNotes={resolveSkillTechnicalNotes(
                            step.skill,
                            help
                          )}
                          routing={resolveSkillRoutingHint(step.skill, help)}
                        />
                      ) : (
                        <p className="text-neutral-400">
                          Este paso no tiene una habilidad automatizada
                          asignada.
                        </p>
                      )}
                      {step.requiredAssetKeys.length > 0 ? (
                        <p>
                          Recursos requeridos:{" "}
                          {step.requiredAssetKeys.map((key) => (
                            <span key={key} className="mr-1 inline-block">
                              <TechId value={key} />
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </>
                  }
                />
              );
            })
          )}
        </DetailSection>

        <DetailSection title="Plantillas de trabajo">
          {graph.work_templates.length === 0 ? (
            <p className="text-neutral-500">{emptyWorkTemplatesMessage()}</p>
          ) : (
            graph.work_templates.map((template, index) => (
              <ExpandableItem
                key={`${template.on_enter_state}-${template.work_type}-${index}`}
                summary={
                  <span>
                    Al entrar a{" "}
                    <span className="font-medium">
                      {labelByKey.get(template.on_enter_state) ??
                        template.on_enter_state}
                    </span>
                    : <TechId value={template.work_type} />
                  </span>
                }
                details={
                  <>
                    <p>
                      Estado de entrada:{" "}
                      <TechId kind="Estado" value={template.on_enter_state} />
                    </p>
                    {template.required_capability ? (
                      <p>
                        Capacidad requerida:{" "}
                        <TechId value={template.required_capability} />
                      </p>
                    ) : null}
                    {template.depends_on?.length ? (
                      <p>
                        Depende de: {template.depends_on.join(", ")}
                      </p>
                    ) : null}
                  </>
                }
              />
            ))
          )}
        </DetailSection>

        <DetailSection
          title="Criterios de finalización"
          hint="Qué considera esta versión como flujo terminado."
        >
          <p>
            <span className="text-neutral-500">Paso final:</span>{" "}
            {graph.completion.terminal_states
              .map((key) => labelByKey.get(key) ?? key)
              .join(", ")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {graph.completion.terminal_states.map((key) => (
              <TechId key={key} kind="Estado" value={key} />
            ))}
          </div>
          <p className="mt-2">
            <span className="text-neutral-500">
              Evidencia necesaria para finalizar:
            </span>{" "}
            {graph.completion.required_evidence.length > 0
              ? graph.completion.required_evidence
                  .map((item) => evidenceInputLabel(item))
                  .join("; ")
              : "Ninguna evidencia adicional declarada."}
          </p>
          {graph.completion.required_evidence.length > 0 ? (
            <div className="mt-1 space-y-1">
              {graph.completion.required_evidence.map((item) => (
                <p key={item}>
                  <KindWithTechId
                    kind="Evidencia"
                    label={evidenceInputLabel(item)}
                    value={item}
                  />
                </p>
              ))}
            </div>
          ) : null}
        </DetailSection>

        <DetailSection title="Verificaciones y aprobaciones">
          {graph.postconditions.length === 0 && graph.approvals.length === 0 ? (
            <p className="text-neutral-400">
              Sin verificaciones ni aprobaciones declaradas.
            </p>
          ) : (
            <>
              {graph.postconditions.map((postcondition) => {
                const stepLabel =
                  labelByKey.get(postcondition.state) ?? postcondition.state;
                return (
                  <ExpandableItem
                    key={postcondition.state}
                    summary={
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{stepLabel}</span>
                        <span className="rounded border border-sky-300 bg-sky-50 px-1 py-0.5 text-[10px] text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                          Verificación
                        </span>
                      </span>
                    }
                    details={
                      <div className="space-y-1">
                        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-neutral-500">
                            Se ejecuta al llegar a
                          </span>
                          <KindWithTechId
                            kind="Estado"
                            label={stepLabel}
                            value={postcondition.state}
                          />
                        </p>
                        {postcondition.checks.map((check) => (
                          <p key={check}>
                            <KindWithTechId
                              kind="Verificación"
                              label={checkLabel(check)}
                              value={check}
                            />
                          </p>
                        ))}
                      </div>
                    }
                  />
                );
              })}
              {graph.approvals.map((approval) => (
                <ExpandableItem
                  key={approval.kind}
                  summary={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">
                        {approvalKindLabel(approval.kind)}
                      </span>
                      <span className="rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        Aprobación humana
                      </span>
                    </span>
                  }
                  details={
                    <div className="space-y-1">
                      <p>
                        <KindWithTechId
                          kind="Aprobación"
                          label={approvalKindLabel(approval.kind)}
                          value={approval.kind}
                        />
                      </p>
                      <p className="font-medium text-neutral-500">
                        Evidencia considerada
                      </p>
                      {approval.evidence_inputs.length === 0 ? (
                        <p className="text-neutral-400">
                          Sin entradas de evidencia declaradas.
                        </p>
                      ) : (
                        approval.evidence_inputs.map((input) => (
                          <p key={input}>
                            <KindWithTechId
                              kind="Evidencia"
                              label={evidenceInputLabel(input)}
                              value={input}
                            />
                          </p>
                        ))
                      )}
                    </div>
                  }
                />
              ))}
            </>
          )}
        </DetailSection>
      </div>

      <details className="rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        <summary className="cursor-pointer font-semibold text-neutral-500">
          Detalle técnico
        </summary>
        <div className="mt-2 space-y-2 text-neutral-600 dark:text-neutral-300">
          <p>
            Alcance: {ownerScopeLabel(definition.owner_scope)} · casos:{" "}
            {pinnedCasesLabel(row.pinnedActiveCases)}
          </p>
          <p>
            <TechId kind="Hash" value={definition.definition_hash} />
          </p>
          <div className="flex flex-wrap gap-1">
            {graph.states.map((state) => (
              <TechId key={state.key} kind="Estado" value={state.key} />
            ))}
          </div>
          {graph.impact_dependencies &&
          Object.keys(graph.impact_dependencies).length > 0 ? (
            <p>
              Dependencias de impacto:{" "}
              {Object.keys(graph.impact_dependencies).map((key) => (
                <span key={key} className="mr-1 inline-block">
                  <TechId value={key} />
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseStatus,
} from "@agents/types";

export const OPERATIONAL_CASE_STATUS_LABELS: Record<
  OperationalCaseStatus,
  string
> = {
  active: "Activo",
  waiting_internal: "Esperando asesor",
  waiting_external: "Esperando externo",
  paused: "Pausado",
  completed: "Completado",
  failed: "Fallido",
};

export const OPERATIONAL_CASE_STATUS_BADGES: Record<
  OperationalCaseStatus,
  string
> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  waiting_internal: "border-violet-200 bg-violet-50 text-violet-700",
  waiting_external: "border-amber-200 bg-amber-50 text-amber-700",
  paused: "border-neutral-200 bg-neutral-50 text-neutral-600",
  completed: "border-blue-200 bg-blue-50 text-blue-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

const STEP_LABELS: Record<string, string> = {
  intake: "Completar registro del caso",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  step_completed: "Paso completado",
  reminder_sent: "Recordatorio enviado",
  escalated: "Escalado",
  human_decision: "Decisión humana",
  external_response: "Respuesta externa",
  state_changed: "Cambio de estado",
  error: "Error",
};

const ACTOR_LABELS: Record<string, string> = {
  system: "sistema",
  agent: "agente",
  user: "usuario",
  external: "externo",
};

export function operationalCaseEventTypeLabel(value: string): string {
  return EVENT_TYPE_LABELS[value] ?? value;
}

export function operationalCaseActorLabel(value: string): string {
  return ACTOR_LABELS[value] ?? value;
}

export type OperationalCaseInstanceLatestEvent = {
  eventTypeLabel: string;
  actorLabel: string;
  createdAt: string;
};

export function operationalCaseLatestEventSummary(
  event: Pick<OperationalCaseEvent, "event_type" | "actor" | "created_at">
): OperationalCaseInstanceLatestEvent {
  return {
    eventTypeLabel: operationalCaseEventTypeLabel(event.event_type),
    actorLabel: operationalCaseActorLabel(event.actor),
    createdAt: event.created_at,
  };
}

export function formatOperationalCaseDateTime(
  value: string | null | undefined
): string {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function operationalCaseStepLabel(
  step: string | null | undefined
): string {
  if (!step) return "Sin definir";
  return STEP_LABELS[step] ?? step;
}

export function operationalCaseDisplayTitle(opCase: OperationalCase): string {
  const ctx =
    opCase.context_jsonb &&
    typeof opCase.context_jsonb === "object" &&
    !Array.isArray(opCase.context_jsonb)
      ? (opCase.context_jsonb as Record<string, unknown>)
      : {};
  const propertyData =
    ctx.property_data &&
    typeof ctx.property_data === "object" &&
    !Array.isArray(ctx.property_data)
      ? (ctx.property_data as Record<string, unknown>)
      : {};

  const clean = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const propertyTitle = clean(ctx.property_title);
  const title = clean(ctx.title);
  const propertyType = clean(ctx.property_type) || clean(propertyData.property_type);
  const address =
    clean(propertyData.address) ||
    clean(propertyData.property_address) ||
    clean(ctx.property_address) ||
    [clean(propertyData.street), clean(propertyData.exterior_number)]
      .filter(Boolean)
      .join(" ");
  const leadName = clean(ctx.lead_name);
  const titleLooksGeneric =
    Boolean(title) &&
    ((propertyType && title.toLowerCase() === propertyType.toLowerCase()) ||
      (title.length <= 12 && !/\d/.test(title) && !/\s/.test(title)));

  // Preferir títulos específicos (property_title / dirección) sobre nicknames
  // genéricos tipo "Casa" que suelen venir de property_type.
  if (propertyTitle) return propertyTitle;
  if (title && !titleLooksGeneric) return title;
  if (address) return address;
  if (title) return title;
  if (leadName) return leadName;
  return String(opCase.current_step ?? opCase.id);
}

export type OperationalCaseInstanceSkillMeta = {
  slug: string;
  kindLabel: string;
  sourceLabel: string;
  exists: boolean;
};

export function OperationalCaseInstanceCard({
  opCase,
  href,
  caseTypeDisplayName,
  stepLabel,
  skillMeta,
  latestEvent,
  workChip,
}: {
  opCase: OperationalCase;
  href: string;
  caseTypeDisplayName?: string | null;
  stepLabel?: string | null;
  skillMeta?: OperationalCaseInstanceSkillMeta | null;
  latestEvent?: OperationalCaseInstanceLatestEvent | null;
  /**
   * Chip de resumen del plano de trabajo (Slice 2.5-3): solo n items +
   * indicador de bloqueo. Los estados de trabajo NUNCA se muestran en la
   * superficie del broker.
   */
  workChip?: string | null;
}) {
  const isTestCase = opCase.context_jsonb?.test_mode === true;
  const resolvedStepLabel = opCase.current_step
    ? (stepLabel ?? operationalCaseStepLabel(opCase.current_step))
    : null;

  return (
    <a
      href={href}
      className="block rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-violet-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {caseTypeDisplayName ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {caseTypeDisplayName}
              </span>
            ) : null}
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${OPERATIONAL_CASE_STATUS_BADGES[opCase.status]}`}
            >
              {OPERATIONAL_CASE_STATUS_LABELS[opCase.status]}
            </span>
            {resolvedStepLabel ? (
              <span
                className="max-w-[14rem] truncate rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200"
                title={
                  opCase.current_step !== resolvedStepLabel
                    ? opCase.current_step ?? undefined
                    : undefined
                }
              >
                {resolvedStepLabel}
              </span>
            ) : null}
            {isTestCase ? (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                Prueba
              </span>
            ) : null}
            {opCase.context_jsonb?.created_from === "agent_conversation" ? (
              <span
                className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700"
                title="Este caso lo creó el agente a partir de una conversación (chat o Telegram), no del formulario web."
              >
                Conversacional
              </span>
            ) : null}
            {workChip ? (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {workChip}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 truncate font-semibold">
            {operationalCaseDisplayTitle(opCase)}
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            {resolvedStepLabel
              ? `Próxima acción: ${formatOperationalCaseDateTime(opCase.next_action_at)}`
              : `Paso: Sin definir · Próxima acción: ${formatOperationalCaseDateTime(opCase.next_action_at)}`}
          </p>
        </div>
        <div className="text-right text-xs text-neutral-500">
          v{opCase.version}
          <br />
          {formatOperationalCaseDateTime(opCase.updated_at)}
        </div>
      </div>

      {skillMeta ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {skillMeta.slug}
          </span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {skillMeta.kindLabel}
          </span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {skillMeta.sourceLabel}
          </span>
          {!skillMeta.exists ? (
            <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">
              habilidad no encontrada
            </span>
          ) : null}
        </div>
      ) : null}

      {latestEvent ? (
        <p className="mt-3 text-xs text-neutral-500">
          Último evento: {latestEvent.eventTypeLabel} · {latestEvent.actorLabel}{" "}
          · {formatOperationalCaseDateTime(latestEvent.createdAt)}
        </p>
      ) : null}
    </a>
  );
}

export function OperationalCaseInstanceList({
  cases,
  getHref,
  getCaseTypeDisplayName,
  getStepLabel,
  getSkillMeta,
  getLatestEvent,
  getWorkChip,
}: {
  cases: OperationalCase[];
  getHref: (opCase: OperationalCase) => string;
  getCaseTypeDisplayName?: (opCase: OperationalCase) => string | null;
  getStepLabel?: (opCase: OperationalCase) => string | null;
  getSkillMeta?: (opCase: OperationalCase) => OperationalCaseInstanceSkillMeta | null;
  getLatestEvent?: (
    opCase: OperationalCase
  ) => OperationalCaseInstanceLatestEvent | null;
  getWorkChip?: (opCase: OperationalCase) => string | null;
}) {
  return (
    <div className="grid w-full gap-3">
      {cases.map((opCase) => (
        <OperationalCaseInstanceCard
          key={opCase.id}
          opCase={opCase}
          href={getHref(opCase)}
          caseTypeDisplayName={getCaseTypeDisplayName?.(opCase) ?? null}
          stepLabel={getStepLabel?.(opCase) ?? null}
          skillMeta={getSkillMeta?.(opCase) ?? null}
          latestEvent={getLatestEvent?.(opCase) ?? null}
          workChip={getWorkChip?.(opCase) ?? null}
        />
      ))}
    </div>
  );
}

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createOperationalCase,
  createServerClient,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listActiveAccountSkillsForUser,
  listOperationalCasesForUser,
  listOperationalCaseTypesForUser,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseStatus,
  OperationalCaseType,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { CaseTypesPanel } from "./case-types-panel";
import { CreateCasePanel } from "./create-case-panel";

export const dynamic = "force-dynamic";

type Search = { case?: string };

const CASE_STATUSES: OperationalCaseStatus[] = [
  "active",
  "waiting_external",
  "paused",
  "completed",
  "failed",
];

const STATUS_LABELS: Record<OperationalCaseStatus, string> = {
  active: "Activo",
  waiting_external: "Esperando externo",
  paused: "Pausado",
  completed: "Completado",
  failed: "Fallido",
};

const STATUS_BADGES: Record<OperationalCaseStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  waiting_external: "border-amber-200 bg-amber-50 text-amber-700",
  paused: "border-neutral-200 bg-neutral-50 text-neutral-600",
  completed: "border-blue-200 bg-blue-50 text-blue-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

async function createOperationalCaseAction(formData: FormData) {
  "use server";

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const caseTypeId = String(formData.get("case_type_id") ?? "").trim();
  if (!caseTypeId) redirect("/operational-cases?error=missing_case_type");

  const db = createServerClient();
  const selectedType = await getOperationalCaseTypeById(db, caseTypeId);
  if (
    !selectedType ||
    (selectedType.user_id && selectedType.user_id !== user.id)
  ) {
    redirect("/operational-cases?error=invalid_case_type");
  }

  const currentStep =
    String(formData.get("current_step") ?? "").trim() || "intake";
  const fieldNames = String(formData.get("intake_field_names") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const context = Object.fromEntries(
    fieldNames.map((name) => [
      name,
      String(formData.get(`context_${name}`) ?? "").trim() || undefined,
    ])
  );
  const title =
    String(context.property_title ?? "").trim() ||
    String(context.lead_name ?? "").trim();
  const externalName =
    String(context.owner_name ?? "").trim() ||
    String(context.lead_name ?? "").trim();
  const telegramChatIdRaw = String(context.telegram_chat_id ?? "").trim();
  const telegramChatId = telegramChatIdRaw
    ? Number(telegramChatIdRaw)
    : undefined;

  const opCase = await createOperationalCase(db, {
    userId: user.id,
    caseTypeId: selectedType!.id,
    caseType: selectedType!.case_type,
    currentStep,
    externalContact:
      externalName || Number.isFinite(telegramChatId)
        ? {
            channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
            chat_id: Number.isFinite(telegramChatId)
              ? telegramChatId
              : undefined,
            display_name: externalName || undefined,
          }
        : undefined,
    context: {
      ...context,
      title: title || undefined,
      created_from: "web_operational_cases_ui",
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "state_changed",
    actor: "user",
    payload: {
      source: "web_ui",
      status: opCase.status,
      current_step: opCase.current_step,
    },
  });

  revalidatePath("/operational-cases");
  redirect(`/operational-cases?case=${opCase.id}`);
}

function formatDate(value: string | null): string {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function casesEnOperacionLabel(count: number): string {
  if (count === 1) return "1 caso en operación";
  return `${count} casos en operación`;
}

const STEP_LABELS: Record<string, string> = {
  intake: "Captura inicial",
};

function stepLabel(step: string | null | undefined): string {
  if (!step) return "Sin definir";
  return STEP_LABELS[step] ?? step;
}

function skillKindLabel(kind: string): string {
  if (kind === "composite") return "compuesta";
  if (kind === "atomic") return "atómica";
  return kind;
}

function skillSourceLabel(source: string): string {
  if (source === "account") return "cuenta";
  if (source === "global") return "producto";
  return source;
}

function skillScopeLabel(scope: string): string {
  if (scope === "business") return "negocio";
  if (scope === "personal") return "personal";
  if (scope === "shared") return "compartido";
  return scope;
}

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

function eventTypeLabel(value: string): string {
  return EVENT_TYPE_LABELS[value] ?? value;
}

function actorLabel(value: string): string {
  return ACTOR_LABELS[value] ?? value;
}

function toShortJson(value: Record<string, unknown>): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 1400 ? `${text.slice(0, 1400)}\n...` : text;
}

function typeById(types: OperationalCaseType[]) {
  return new Map(types.map((t) => [t.id, t]));
}

/**
 * Dedupe de case types por `case_type`. Si el usuario ya creó/personalizó una
 * versión privada del mismo slug, esa gana sobre la versión de producto. La
 * versión global "perdida" se devuelve aparte para poder mostrar en UI que la
 * versión de cuenta personaliza la de producto.
 */
function dedupeCaseTypes(types: OperationalCaseType[]): {
  visible: OperationalCaseType[];
  globalCounterpartBySlug: Map<string, OperationalCaseType>;
} {
  const bySlug = new Map<string, OperationalCaseType[]>();
  for (const t of types) {
    const arr = bySlug.get(t.case_type) ?? [];
    arr.push(t);
    bySlug.set(t.case_type, arr);
  }
  const visible: OperationalCaseType[] = [];
  const globalCounterpartBySlug = new Map<string, OperationalCaseType>();
  for (const [, arr] of bySlug) {
    const account = arr.find((t) => t.user_id !== null);
    const global = arr.find((t) => t.user_id === null);
    if (account) {
      visible.push(account);
      if (global) globalCounterpartBySlug.set(account.case_type, global);
    } else if (global) {
      visible.push(global);
    }
  }
  visible.sort((a, b) => a.display_name.localeCompare(b.display_name, "es"));
  return { visible, globalCounterpartBySlug };
}

function latestEventByCase(events: OperationalCaseEvent[]) {
  const map = new Map<string, OperationalCaseEvent>();
  for (const event of events) map.set(event.case_id, event);
  return map;
}

export default async function OperationalCasesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const [caseTypes, cases, accountSkills, registry] = await Promise.all([
    listOperationalCaseTypesForUser(db, user.id),
    listOperationalCasesForUser(db, user.id, {
      statuses: CASE_STATUSES,
      limit: 100,
    }),
    listActiveAccountSkillsForUser(db, user.id),
    getSkillRegistryForUser(db, user.id).catch((err) => {
      console.warn("[operational-cases] failed to load skill registry:", err);
      return null;
    }),
  ]);

  const selectedCase =
    cases.find((opCase) => opCase.id === sp.case) ?? cases[0] ?? null;

  const selectedEvents = selectedCase
    ? await getRecentOperationalCaseEvents(db, selectedCase.id, 50)
    : [];
  const latestEvents = latestEventByCase(
    (
      await Promise.all(
        cases.map((opCase) => getRecentOperationalCaseEvents(db, opCase.id, 1))
      )
    ).flat()
  );

  // Importante: la lista cruda puede contener duplicados por slug cuando el
  // usuario tiene una versión privada del mismo case_type que la global. Esto
  // es legítimo a nivel de datos (la tabla lo permite por diseño) pero a nivel
  // de UI sólo queremos mostrar uno: la versión de cuenta gana.
  const { visible: visibleCaseTypes, globalCounterpartBySlug } =
    dedupeCaseTypes(caseTypes);
  // El typeById sigue construyéndose con TODOS los rows (no sólo los visibles)
  // porque las instancias en `operational_cases` pueden apuntar al case_type_id
  // global aunque exista uno privado del mismo slug, y necesitamos resolver el
  // nombre.
  const caseTypeMap = typeById(caseTypes);
  const accountSkillSlugs = new Set(accountSkills.map((s) => s.slug));
  const testCaseCount = cases.filter(
    (opCase) => opCase.context_jsonb?.test_mode === true
  ).length;
  const realCaseCount = cases.length - testCaseCount;

  function skillInfo(slug: string) {
    const metadata = registry?.get(slug)?.metadata ?? null;
    return {
      source: accountSkillSlugs.has(slug) ? "account" : "global",
      kind: metadata && metadata.includes.length > 0 ? "composite" : "atomic",
      scope: metadata?.scope ?? "business",
      includes: metadata?.includes ?? [],
      exists: Boolean(metadata),
    };
  }
  const skillInfoBySlug = Object.fromEntries(
    visibleCaseTypes.map((type) => [
      type.default_skill_slug,
      skillInfo(type.default_skill_slug),
    ])
  );

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50">
      <header className="border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-700 dark:text-violet-300">
              Operaciones
            </p>
            <h1 className="text-lg font-semibold">Casos operacionales</h1>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <a
              href="/settings/operational-case-types"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Casos de uso
            </a>
            <a
              href="/chat"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Chat
            </a>
            <a
              href="/settings"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Ajustes
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">Casos en operación</h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Instancias activas de casos multi-día. Cada una usa el caso
                  de uso seleccionado como plantilla operativa.
                </p>
              </div>
              <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {casesEnOperacionLabel(realCaseCount)}
                {testCaseCount > 0 ? ` · ${testCaseCount} prueba` : ""}
              </span>
            </div>
          </div>

          {cases.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              Aún no hay casos en operación para esta cuenta. Pon un caso en
              operación desde el panel lateral; eso crea una instancia concreta
              a partir de un caso de uso.
            </div>
          ) : (
            <div className="grid gap-3">
              {cases.map((opCase) => {
                const type = caseTypeMap.get(opCase.case_type_id);
                const skillSlug = type?.default_skill_slug ?? "(sin skill)";
                const info = skillInfo(skillSlug);
                const latest = latestEvents.get(opCase.id);
                const selected = selectedCase?.id === opCase.id;
                const isTestCase = opCase.context_jsonb?.test_mode === true;

                return (
                  <a
                    key={opCase.id}
                    href={`/operational-cases?case=${opCase.id}`}
                    className={`block rounded-2xl border bg-white p-4 shadow-sm transition hover:border-violet-300 hover:shadow-md dark:bg-neutral-900 ${
                      selected
                        ? "border-violet-400 dark:border-violet-500"
                        : "border-neutral-200 dark:border-neutral-800"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGES[opCase.status]}`}
                          >
                            {STATUS_LABELS[opCase.status]}
                          </span>
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            {type?.display_name ?? opCase.case_type}
                          </span>
                          {isTestCase ? (
                            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                              Prueba
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-2 truncate font-semibold">
                          {String(
                            opCase.context_jsonb.title ??
                              opCase.context_jsonb.property_title ??
                              opCase.context_jsonb.lead_name ??
                              opCase.current_step ??
                              opCase.id
                          )}
                        </h3>
                        <p className="mt-1 text-xs text-neutral-500">
                          Paso: {stepLabel(opCase.current_step)} · Próxima
                          acción: {formatDate(opCase.next_action_at)}
                        </p>
                      </div>
                      <div className="text-right text-xs text-neutral-500">
                        v{opCase.version}
                        <br />
                        {formatDate(opCase.updated_at)}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        {skillSlug}
                      </span>
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {skillKindLabel(info.kind)}
                      </span>
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {skillSourceLabel(info.source)}
                      </span>
                      {!info.exists ? (
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-700">
                          habilidad no encontrada
                        </span>
                      ) : null}
                    </div>

                    {latest ? (
                      <p className="mt-3 text-xs text-neutral-500">
                        Último evento: {eventTypeLabel(latest.event_type)} ·{" "}
                        {actorLabel(latest.actor)} ·{" "}
                        {formatDate(latest.created_at)}
                      </p>
                    ) : null}
                  </a>
                );
              })}
            </div>
          )}

          {selectedCase ? (
            <CaseDetail
              opCase={selectedCase}
              type={caseTypeMap.get(selectedCase.case_type_id) ?? null}
              events={selectedEvents}
              skillInfo={skillInfo(
                caseTypeMap.get(selectedCase.case_type_id)
                  ?.default_skill_slug ??
                  ""
              )}
            />
          ) : null}
        </section>

        <aside className="space-y-4">
          <CreateCasePanel
            action={createOperationalCaseAction}
            caseTypes={visibleCaseTypes}
          />
          <CaseTypesPanel
            caseTypes={visibleCaseTypes}
            skillInfo={skillInfoBySlug}
            globalCounterpartBySlug={Object.fromEntries(globalCounterpartBySlug)}
          />
        </aside>
      </main>
    </div>
  );
}

function CaseDetail({
  opCase,
  type,
  events,
  skillInfo,
}: {
  opCase: OperationalCase;
  type: OperationalCaseType | null;
  events: OperationalCaseEvent[];
  skillInfo: {
    source: string;
    kind: string;
    scope: string;
    includes: readonly string[];
    exists: boolean;
  };
}) {
  const skillSlug = type?.default_skill_slug ?? "(sin skill)";
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Detalle del caso</h2>
          <p className="mt-1 font-mono text-xs text-neutral-500">{opCase.id}</p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGES[opCase.status]}`}
        >
          {STATUS_LABELS[opCase.status]}
        </span>
        {opCase.context_jsonb?.test_mode === true ? (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">
            Caso de prueba
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Info
          label="Caso de uso"
          value={type?.display_name ?? opCase.case_type}
        />
        <Info label="Paso actual" value={stepLabel(opCase.current_step)} />
        <Info label="Próxima acción" value={formatDate(opCase.next_action_at)} />
        <Info label="Vencimiento" value={formatDate(opCase.due_at)} />
        <Info label="Versión" value={`v${opCase.version}`} />
        <Info
          label="Contacto externo"
          value={
            opCase.external_contact_jsonb.display_name ??
            String(opCase.external_contact_jsonb.chat_id ?? "sin contacto")
          }
        />
      </div>

      <div className="mt-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Habilidad del caso de uso
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-violet-50 px-2 py-1 font-mono text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {skillSlug}
          </span>
          <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {skillKindLabel(skillInfo.kind)}
          </span>
          <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {skillSourceLabel(skillInfo.source)}
          </span>
          <span className="rounded bg-neutral-100 px-2 py-1 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            Ámbito: {skillScopeLabel(skillInfo.scope)}
          </span>
        </div>
        {skillInfo.includes.length > 0 ? (
          <p className="mt-2 text-xs text-neutral-500">
            Incluye: {skillInfo.includes.join(", ")}
          </p>
        ) : null}
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Contexto</h3>
        <pre className="mt-2 overflow-auto rounded-xl bg-neutral-950 p-3 text-xs text-neutral-100">
          {toShortJson(opCase.context_jsonb)}
        </pre>
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Historial de eventos</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Solo lectura: el registro no se edita, solo crece con nuevos eventos.
        </p>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Sin eventos todavía.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">
                    {eventTypeLabel(event.event_type)}
                    <span className="text-xs font-normal text-neutral-500">
                      {" "}
                      · {actorLabel(event.actor)}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {formatDate(event.created_at)}
                  </div>
                </div>
                <pre className="mt-2 overflow-auto rounded-lg bg-neutral-100 p-2 text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-200">
                  {toShortJson(event.payload_jsonb)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 break-words">{value}</div>
    </div>
  );
}

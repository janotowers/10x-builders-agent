import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash, randomUUID } from "node:crypto";
import {
  CASE_DOCUMENTS_BUCKET,
  createOperationalCase,
  createOperationalCaseDocument,
  createServerClient,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  listActiveAccountSkillsForUser,
  listOperationalCasesForUser,
  listOperationalCaseTypesForUser,
  updateOperationalCase,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import type {
  OperationalCase,
  OperationalCaseDocument,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  OperationalCaseStatus,
  OperationalCaseType,
} from "@agents/types";
import { resolveOperationalCaseDocumentRequestTarget } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { CreateCasePanel } from "./create-case-panel";
import { OperationalCasesFilters } from "./operational-cases-filters";
import type { OperationalCasesListFilters } from "@/lib/operational-cases/instance-list-filters";
import {
  filterOperationalCases,
  operationalCasesListHref,
  operationalCasesListQuerySuffix,
  parseOperationalCasesListFilters,
  searchParamValue,
} from "@/lib/operational-cases/instance-list-filters";
import {
  formatOperationalCaseDateTime,
  OPERATIONAL_CASE_STATUS_BADGES,
  OPERATIONAL_CASE_STATUS_LABELS,
  operationalCaseLatestEventSummary,
  OperationalCaseInstanceList,
} from "@/lib/operational-cases/instance-list-ui";
import { AppShell } from "@/components/app-shell";
import {
  caseDocumentRequestTargetLabel,
  setCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";

export const dynamic = "force-dynamic";

type Search = OperationalCasesListFilters & { case?: string; case_id?: string };

const CASE_STATUSES: OperationalCaseStatus[] = [
  "active",
  "waiting_internal",
  "waiting_external",
  "paused",
  "completed",
  "failed",
];

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
  const fields = Array.isArray(selectedType.intake_schema_jsonb)
    ? selectedType.intake_schema_jsonb
    : [];
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const context = Object.fromEntries(
    fieldNames.map((name) => {
      const field = fieldByName.get(name);
      if (field?.type === "multi_select") {
        const values = formData
          .getAll(`context_${name}`)
          .map((value) => String(value).trim())
          .filter(Boolean);
        return [name, values.length > 0 ? values : undefined];
      }
      return [
        name,
        String(formData.get(`context_${name}`) ?? "").trim() || undefined,
      ];
    })
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
      document_request_target: resolveOperationalCaseDocumentRequestTarget({
        externalContact:
          externalName || Number.isFinite(telegramChatId)
            ? {
                channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
                chat_id: Number.isFinite(telegramChatId) ? telegramChatId : undefined,
                display_name: externalName || undefined,
              }
            : undefined,
      }),
      document_request_target_decided_by: "default",
      document_request_target_decided_at: new Date().toISOString(),
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

function safePathSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "document";
}

function documentKindBlocking(kind: string) {
  return kind === "escritura_descripcion";
}

async function uploadCaseDocumentAction(formData: FormData) {
  "use server";

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const caseId = String(formData.get("case_id") ?? "").trim();
  const kind = String(formData.get("document_kind") ?? "").trim();
  const file = formData.get("document_file");
  if (!caseId || !kind || !(file instanceof File) || file.size === 0) {
    redirect(`/operational-cases?case=${caseId || ""}&error=missing_document`);
  }

  const db = createServerClient();
  const opCase = (await listOperationalCasesForUser(db, user.id, {
    statuses: CASE_STATUSES,
    limit: 100,
  })).find((item) => item.id === caseId);
  if (!opCase) redirect("/operational-cases?error=case_not_found");

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ext = file.name.includes(".")
    ? safePathSegment(file.name.split(".").pop() ?? "bin")
    : "bin";
  const storagePath = `${user.id}/${caseId}/${randomUUID()}-${safePathSegment(
    file.name.replace(/\.[^.]+$/, "")
  )}.${ext}`;
  const { error: uploadError } = await db.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const document = await createOperationalCaseDocument(db, {
    caseId,
    userId: user.id,
    kind,
    displayName: documentKindLabel(kind),
    storagePath,
    originalName: file.name,
    contentType: file.type || "application/octet-stream",
    fileSizeBytes: file.size,
    sha256,
    source: "advisor_web",
    sourceMetadata: { source: "operational_cases_ui" },
    blocking: documentKindBlocking(kind),
  });

  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "external_response",
    actor: "user",
    payload: {
      kind: "document_registered",
      source: "advisor_web",
      document_id: document.id,
      document_kind: document.kind,
      current_step: opCase.current_step,
      step_key: opCase.current_step,
    },
  });

  revalidatePath("/operational-cases");
  redirect(`/operational-cases?case=${caseId}`);
}

async function setDocumentRequestTargetAction(formData: FormData) {
  "use server";

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const caseId = String(formData.get("case_id") ?? "").trim();
  const target = String(formData.get("document_request_target") ?? "").trim();
  if (!caseId || (target !== "internal_user" && target !== "external_contact")) {
    redirect(`/operational-cases?case=${caseId || ""}&error=invalid_document_target`);
  }

  const db = createServerClient();
  const opCase = (await listOperationalCasesForUser(db, user.id, {
    statuses: CASE_STATUSES,
    limit: 100,
  })).find((item) => item.id === caseId);
  if (!opCase) redirect("/operational-cases?error=case_not_found");

  const updated = await setCaseDocumentRequestTarget({
    db,
    opCase,
    target,
    decidedBy: "user",
  });

  await insertOperationalCaseEvent(db, {
    caseId,
    eventType: "state_changed",
    actor: "user",
    payload: {
      source: "web_operational_cases_ui",
      kind: "document_request_target_changed",
      document_request_target: target,
      previous_target:
        typeof opCase.context_jsonb?.document_request_target === "string"
          ? opCase.context_jsonb.document_request_target
          : null,
      case_version: updated.version,
    },
  });

  if (
    target === "internal_user" &&
    opCase.current_step === "awaiting_documents" &&
    opCase.status === "waiting_external"
  ) {
    await updateOperationalCase(db, opCase.id, updated.version, {
      status: "waiting_internal",
      nextActionAt: null,
    });
  }

  revalidatePath("/operational-cases");
  redirect(`/operational-cases?case=${caseId}`);
}

function formatDate(value: string | null): string {
  return formatOperationalCaseDateTime(value);
}

function casesEnOperacionLabel(count: number): string {
  if (count === 1) return "1 flujo en curso";
  return `${count} flujos en curso`;
}

const STEP_LABELS: Record<string, string> = {
  intake: "Completar registro del caso",
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

function documentKindLabel(value: string): string {
  const labels: Record<string, string> = {
    escritura_descripcion: "Escritura - descripción de la propiedad",
    predial: "Predial",
    ine: "INE",
    comprobante_domicilio: "Comprobante de domicilio",
    boleta_registral: "Boleta registral",
    escritura_primera_hoja: "Escritura - primera hoja",
    escritura_ultima_hoja: "Escritura - última hoja",
    unknown: "Sin clasificar",
  };
  return labels[value] ?? value;
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

function flowStepLabelMap(types: OperationalCaseType[]) {
  const map = new Map<string, Map<string, string>>();
  for (const type of types) {
    const steps = Array.isArray(type.operational_flow_jsonb)
      ? (type.operational_flow_jsonb as OperationalCaseFlowStep[])
      : [];
    const labels = new Map<string, string>();
    for (const step of steps) {
      if (step.step_key) labels.set(step.step_key, step.step_label);
    }
    map.set(type.id, labels);
  }
  return map;
}

function caseTypeForInstance(
  opCase: OperationalCase,
  caseTypes: OperationalCaseType[],
  caseTypeMap: Map<string, OperationalCaseType>
) {
  return (
    caseTypeMap.get(opCase.case_type_id) ??
    caseTypes.find((type) => type.case_type === opCase.case_type) ??
    null
  );
}

function stepLabelForInstance(
  opCase: OperationalCase,
  caseTypes: OperationalCaseType[],
  caseTypeMap: Map<string, OperationalCaseType>,
  stepLabelsByTypeId: Map<string, Map<string, string>>
) {
  const step = opCase.current_step;
  if (!step) return "Sin definir";
  const type = caseTypeForInstance(opCase, caseTypes, caseTypeMap);
  return (type && stepLabelsByTypeId.get(type.id)?.get(step)) ?? step;
}

function stepFilterOptions({
  cases,
  caseTypes,
  caseTypeMap,
  stepLabelsByTypeId,
}: {
  cases: OperationalCase[];
  caseTypes: OperationalCaseType[];
  caseTypeMap: Map<string, OperationalCaseType>;
  stepLabelsByTypeId: Map<string, Map<string, string>>;
}) {
  const options = new Map<string, string>();
  for (const opCase of cases) {
    if (!opCase.current_step) continue;
    options.set(
      opCase.current_step,
      stepLabelForInstance(opCase, caseTypes, caseTypeMap, stepLabelsByTypeId)
    );
  }
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
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

  const focusedCaseId =
    searchParamValue(sp.case) ?? searchParamValue(sp.case_id) ?? null;
  const selectedCase = focusedCaseId
    ? cases.find((opCase) => opCase.id === focusedCaseId) ?? null
    : null;
  const isFocusedDetailView = Boolean(focusedCaseId);

  const listFilters = parseOperationalCasesListFilters(sp);
  const { visible: visibleCaseTypes } = dedupeCaseTypes(caseTypes);
  const caseTypeMap = typeById(caseTypes);
  const stepLabelsByTypeId = flowStepLabelMap(caseTypes);
  const casesForStepOptions = filterOperationalCases(
    cases,
    { ...listFilters, step: undefined },
    caseTypeMap,
    CASE_STATUSES
  );
  const stepOptions = stepFilterOptions({
    cases: casesForStepOptions,
    caseTypes,
    caseTypeMap,
    stepLabelsByTypeId,
  });
  const filteredCases = isFocusedDetailView
    ? cases
    : filterOperationalCases(cases, listFilters, caseTypeMap, CASE_STATUSES);
  const listQuery = operationalCasesListQuerySuffix(listFilters);

  const selectedEvents = selectedCase
    ? await getRecentOperationalCaseEvents(db, selectedCase.id, 50)
    : [];
  const selectedDocuments = selectedCase
    ? await listOperationalCaseDocuments(db, {
        caseId: selectedCase.id,
        statuses: ["received"],
      })
    : [];
  const latestEvents = isFocusedDetailView
    ? new Map<string, OperationalCaseEvent>()
    : latestEventByCase(
        (
          await Promise.all(
            filteredCases.map((opCase) =>
              getRecentOperationalCaseEvents(db, opCase.id, 1)
            )
          )
        ).flat()
      );

  const accountSkillSlugs = new Set(accountSkills.map((s) => s.slug));
  const testCaseCount = cases.filter(
    (opCase) => opCase.context_jsonb?.test_mode === true
  ).length;
  const realCaseCount = cases.length - testCaseCount;
  const statusFilterOptions = CASE_STATUSES.map((status) => ({
    value: status,
    label: OPERATIONAL_CASE_STATUS_LABELS[status],
  }));

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
  return (
    <AppShell
      title="Flujos en curso"
      description="Bandeja global con instancias de todas las plantillas para seguimiento operativo y soporte."
      actions={
        <a
          href="/settings/operational-case-types"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Plantillas de flujos
        </a>
      }
    >
      {isFocusedDetailView ? (
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/operational-cases${listQuery}`}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              ← Volver a la bandeja
            </a>
          </div>

          {!selectedCase ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              No encontramos ese flujo en curso. Puede haber sido eliminado
              o no pertenecer a tu cuenta.
            </div>
          ) : (
            <CaseDetail
              opCase={selectedCase}
              type={caseTypeMap.get(selectedCase.case_type_id) ?? null}
              events={selectedEvents}
              documents={selectedDocuments}
              skillInfo={skillInfo(
                caseTypeMap.get(selectedCase.case_type_id)
                  ?.default_skill_slug ?? ""
              )}
            />
          )}
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 dark:bg-neutral-800">
              {casesEnOperacionLabel(realCaseCount)}
              {testCaseCount > 0 ? ` · ${testCaseCount} prueba` : ""}
            </span>
          </div>

          <OperationalCasesFilters
            caseTypes={visibleCaseTypes}
            filters={listFilters}
            statusOptions={statusFilterOptions}
            stepOptions={stepOptions}
            resultCount={filteredCases.length}
            totalCount={cases.length}
          />

          {cases.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              Aún no hay flujos en curso para esta cuenta. Lo recomendado es
              iniciar por chat o Telegram.
            </div>
          ) : filteredCases.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              Ninguna instancia coincide con los filtros actuales.{" "}
              <a
                href="/operational-cases"
                className="font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              >
                Limpiar filtros
              </a>
            </div>
          ) : (
            <OperationalCaseInstanceList
              cases={filteredCases}
              getHref={(opCase) =>
                operationalCasesListHref(listFilters, { caseId: opCase.id })
              }
              getCaseTypeDisplayName={(opCase) =>
                caseTypeForInstance(opCase, caseTypes, caseTypeMap)
                  ?.display_name ??
                opCase.case_type
              }
              getStepLabel={(opCase) =>
                stepLabelForInstance(
                  opCase,
                  caseTypes,
                  caseTypeMap,
                  stepLabelsByTypeId
                )
              }
              getSkillMeta={(opCase) => {
                const type = caseTypeForInstance(opCase, caseTypes, caseTypeMap);
                const skillSlug = type?.default_skill_slug ?? "(sin skill)";
                const info = skillInfo(skillSlug);
                return {
                  slug: skillSlug,
                  kindLabel: skillKindLabel(info.kind),
                  sourceLabel: skillSourceLabel(info.source),
                  exists: info.exists,
                };
              }}
              getLatestEvent={(opCase) => {
                const latest = latestEvents.get(opCase.id);
                return latest ? operationalCaseLatestEventSummary(latest) : null;
              }}
            />
          )}

          <details className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <summary className="cursor-pointer text-sm font-semibold">
              Crear caso manualmente
              <span className="ml-2 text-xs font-normal text-neutral-500">
                fallback de soporte o demo; lo normal es abrir casos por chat
              </span>
            </summary>
            <div className="mt-4">
              <CreateCasePanel
                action={createOperationalCaseAction}
                caseTypes={visibleCaseTypes}
              />
            </div>
          </details>
        </section>
      )}
    </AppShell>
  );
}

function CaseDetail({
  opCase,
  type,
  events,
  documents,
  skillInfo,
}: {
  opCase: OperationalCase;
  type: OperationalCaseType | null;
  events: OperationalCaseEvent[];
  documents: OperationalCaseDocument[];
  skillInfo: {
    source: string;
    kind: string;
    scope: string;
    includes: readonly string[];
    exists: boolean;
  };
}) {
  const skillSlug = type?.default_skill_slug ?? "(sin skill)";
  const documentRequestTarget = resolveOperationalCaseDocumentRequestTarget({
    externalContact: opCase.external_contact_jsonb,
    context: opCase.context_jsonb,
  });
  return (
    <section className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Detalle del caso</h2>
          <p className="mt-1 break-all font-mono text-xs text-neutral-500">
            {opCase.id}
          </p>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${OPERATIONAL_CASE_STATUS_BADGES[opCase.status]}`}
        >
          {OPERATIONAL_CASE_STATUS_LABELS[opCase.status]}
        </span>
        {opCase.context_jsonb?.test_mode === true ? (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">
            Caso de prueba
          </span>
        ) : null}
        {opCase.context_jsonb?.created_from === "agent_conversation" ? (
          <span
            className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700"
            title="Este caso lo creó el agente a partir de una conversación (chat o Telegram), no del formulario web."
          >
            Conversacional
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Info
          label="Plantilla de flujo"
          value={type?.display_name ?? opCase.case_type}
        />
        <Info label="Paso actual" value={stepLabel(opCase.current_step)} />
        <Info label="Próxima acción" value={formatDate(opCase.next_action_at)} />
        <Info label="Vencimiento" value={formatDate(opCase.due_at)} />
        <Info label="Versión" value={`v${opCase.version}`} />
        <Info
          label="Solicitud de documentos"
          value={caseDocumentRequestTargetLabel(documentRequestTarget)}
        />
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
          Skill de la plantilla
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

      <div className="mt-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Documentos del caso</h3>
            <p className="mt-1 text-xs text-neutral-500">
              {documentRequestTarget === "external_contact"
                ? "Si el dueño te mandó documentos por otro canal, súbelos aquí para asociarlos al caso y permitir extracción con visión."
                : "Sube aquí los documentos del asesor/equipo interno para continuar el flujo sin depender del contacto externo."}
            </p>
          </div>
          <span className="rounded bg-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {documents.length} recibido{documents.length === 1 ? "" : "s"}
          </span>
        </div>
        <form action={setDocumentRequestTargetAction} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="case_id" value={opCase.id} />
          <input
            type="hidden"
            name="document_request_target"
            value="internal_user"
          />
          <button
            type="submit"
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              documentRequestTarget === "internal_user"
                ? "border-violet-600 bg-violet-50 text-violet-700"
                : "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            }`}
          >
            Los sube el equipo interno
          </button>
        </form>
        <form action={setDocumentRequestTargetAction} className="mt-2 flex flex-wrap gap-2">
          <input type="hidden" name="case_id" value={opCase.id} />
          <input
            type="hidden"
            name="document_request_target"
            value="external_contact"
          />
          <button
            type="submit"
            className={`rounded border px-2 py-1 text-xs font-semibold ${
              documentRequestTarget === "external_contact"
                ? "border-violet-600 bg-violet-50 text-violet-700"
                : "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            }`}
          >
            Pedir al contacto externo
          </button>
        </form>
        <form
          action={uploadCaseDocumentAction}
          encType="multipart/form-data"
          className="mt-3 grid gap-2 rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-950 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <input type="hidden" name="case_id" value={opCase.id} />
          <label>
            <span className="font-semibold text-neutral-700 dark:text-neutral-200">
              Tipo
            </span>
            <select
              name="document_kind"
              className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              defaultValue="escritura_descripcion"
            >
              <option value="escritura_descripcion">Escritura - descripción</option>
              <option value="predial">Predial</option>
              <option value="ine">INE</option>
              <option value="comprobante_domicilio">Comprobante domicilio</option>
              <option value="boleta_registral">Boleta registral</option>
              <option value="escritura_primera_hoja">Escritura - primera hoja</option>
              <option value="escritura_ultima_hoja">Escritura - última hoja</option>
              <option value="unknown">Sin clasificar</option>
            </select>
          </label>
          <label>
            <span className="font-semibold text-neutral-700 dark:text-neutral-200">
              Archivo
            </span>
            <input
              name="document_file"
              type="file"
              accept="image/*,application/pdf"
              required
              className="mt-1 w-full text-xs"
            />
          </label>
          <button
            type="submit"
            className="self-end rounded bg-violet-700 px-3 py-2 font-semibold text-white hover:bg-violet-800"
          >
            Subir
          </button>
        </form>
        {documents.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-500">
            Aún no hay documentos registrados.
          </p>
        ) : (
          <div className="mt-3 grid gap-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="rounded-lg border border-neutral-200 p-2 text-xs dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {documentKindLabel(doc.kind)}
                    {doc.blocking ? " · bloqueante" : ""}
                  </span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {doc.extraction_status}
                  </span>
                </div>
                <p className="mt-1 text-neutral-500">
                  {doc.original_name ?? doc.storage_path} · {doc.source} ·{" "}
                  {formatDate(doc.created_at)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <h3 className="text-sm font-semibold">Contexto</h3>
        <pre className="mt-2 max-w-full overflow-auto rounded-xl bg-neutral-950 p-3 text-xs text-neutral-100">
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

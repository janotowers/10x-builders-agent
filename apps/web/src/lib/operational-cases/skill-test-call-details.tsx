"use client";

import {
  generatedDocumentInputsMatch,
  normalizeGeneratedDocumentArgs,
  normalizeTelegramSendText,
  telegramSendInputsMatch,
  type GeneratedDocumentDedupOptions,
} from "@agents/types";

export type SkillTestToolCallDetail = {
  tool_name: string;
  status: string;
  arguments_json?: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  created_at?: string;
  finished_at?: string | null;
};

export type SkillTestTickScope = "habilidad" | "paso";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function skillTestDocumentDedupOptions(
  calls: SkillTestToolCallDetail[]
): GeneratedDocumentDedupOptions {
  const caseId = calls.find(
    (item) =>
      item.tool_name === "generate_document_from_template" &&
      typeof item.arguments_json?.case_id === "string" &&
      item.arguments_json.case_id.trim()
  )?.arguments_json?.case_id;
  return {
    caseIdFallback: typeof caseId === "string" ? caseId : null,
  };
}

export function skillTestGenerateDocumentIsSemanticDuplicate(
  call: SkillTestToolCallDetail,
  priorCalls: SkillTestToolCallDetail[],
  dedupOptions: GeneratedDocumentDedupOptions
) {
  if (
    call.tool_name !== "generate_document_from_template" ||
    call.status !== "executed" ||
    call.result_json?.skipped_render === true
  ) {
    return false;
  }
  const args = normalizeGeneratedDocumentArgs(
    (call.arguments_json ?? {}) as Record<string, unknown>,
    dedupOptions
  );
  return priorCalls.some(
    (prior) =>
      prior.tool_name === "generate_document_from_template" &&
      prior.status === "executed" &&
      prior.result_json?.skipped_render !== true &&
      generatedDocumentInputsMatch(
        normalizeGeneratedDocumentArgs(
          (prior.arguments_json ?? {}) as Record<string, unknown>,
          dedupOptions
        ),
        args,
        dedupOptions
      )
  );
}

export function formatSkillTestToolCallAuditToken(
  call: SkillTestToolCallDetail,
  options?: {
    priorCalls?: SkillTestToolCallDetail[];
    documentDedupOptions?: GeneratedDocumentDedupOptions;
  }
) {
  if (
    call.tool_name === "generate_document_from_template" &&
    call.result_json?.skipped_render === true
  ) {
    return `${call.tool_name}:deduplicated`;
  }
  if (
    call.tool_name === "generate_document_from_template" &&
    call.status === "executed" &&
    options?.priorCalls &&
    options.documentDedupOptions &&
    skillTestGenerateDocumentIsSemanticDuplicate(
      call,
      options.priorCalls,
      options.documentDedupOptions
    )
  ) {
    return `${call.tool_name}:deduplicated`;
  }
  if (
    call.tool_name === "telegram_send_message_to_contact" &&
    call.result_json?.skipped_send === true
  ) {
    return `${call.tool_name}:deduplicated`;
  }
  return `${call.tool_name}:${call.status}`;
}

export function formatSkillTestToolCallAuditTokenList(
  calls: SkillTestToolCallDetail[]
) {
  const documentDedupOptions = skillTestDocumentDedupOptions(calls);
  return calls.map((call, index) =>
    formatSkillTestToolCallAuditToken(call, {
      priorCalls: calls.slice(0, index),
      documentDedupOptions,
    })
  );
}

export function formatSkillTestCallTimestamp(iso?: string | null) {
  if (!iso) return "sin marca de tiempo";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("es-MX", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Texto completo del mensaje (sin truncar) para revisión en N3/N4. */
export function skillTestTelegramTextPreview(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return "(sin texto en args)";
  return text.trim();
}

export function collectSkillTestTelegramCalls(
  calls: SkillTestToolCallDetail[]
): SkillTestToolCallDetail[] {
  return calls
    .filter((call) => call.tool_name === "telegram_send_message_to_contact")
    .sort((a, b) => {
      const aTime = Date.parse(a.finished_at ?? a.created_at ?? "");
      const bTime = Date.parse(b.finished_at ?? b.created_at ?? "");
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });
}

export function collectSkillTestNotifyUserCalls(
  calls: SkillTestToolCallDetail[]
): SkillTestToolCallDetail[] {
  return calls
    .filter((call) => call.tool_name === "notify_user")
    .sort((a, b) => {
      const aTime = Date.parse(a.finished_at ?? a.created_at ?? "");
      const bTime = Date.parse(b.finished_at ?? b.created_at ?? "");
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });
}

export function skillTestTelegramCallIsSemanticDuplicate(
  call: SkillTestToolCallDetail,
  priorCalls: SkillTestToolCallDetail[]
) {
  if (call.status !== "executed" || call.result_json?.skipped_send === true) {
    return false;
  }
  const args = (call.arguments_json ?? {}) as Record<string, unknown>;
  return priorCalls.some(
    (prior) =>
      prior.status === "executed" &&
      telegramSendInputsMatch(
        (prior.arguments_json ?? {}) as Record<string, unknown>,
        args
      )
  );
}

export function skillTestTelegramCallStatusLabel(
  call: SkillTestToolCallDetail,
  options?: { semanticDuplicate?: boolean }
) {
  if (call.result_json?.skipped_send === true) {
    return "deduplicada, sin reenvío";
  }
  if (options?.semanticDuplicate) {
    return "duplicada sin reenvío (mismo texto que llamada anterior)";
  }
  return call.status;
}

export type SkillTestTelegramSendBuckets = {
  realSends: SkillTestToolCallDetail[];
  backendDeduped: SkillTestToolCallDetail[];
  semanticDuplicates: SkillTestToolCallDetail[];
};

export function classifySkillTestTelegramSends(
  calls: SkillTestToolCallDetail[]
): SkillTestTelegramSendBuckets {
  const telegramCalls = collectSkillTestTelegramCalls(calls);
  const realSends: SkillTestToolCallDetail[] = [];
  const backendDeduped: SkillTestToolCallDetail[] = [];
  const semanticDuplicates: SkillTestToolCallDetail[] = [];
  const priorExecuted: SkillTestToolCallDetail[] = [];

  for (const call of telegramCalls) {
    if (call.status !== "executed") continue;
    if (call.result_json?.skipped_send === true) {
      backendDeduped.push(call);
      priorExecuted.push(call);
      continue;
    }
    if (skillTestTelegramCallIsSemanticDuplicate(call, priorExecuted)) {
      semanticDuplicates.push(call);
      priorExecuted.push(call);
      continue;
    }
    realSends.push(call);
    priorExecuted.push(call);
  }

  return { realSends, backendDeduped, semanticDuplicates };
}

type NotifyChannelResultRow = {
  channel: string;
  ok?: boolean;
  status?: string;
  reason?: string;
};

function parseNotifyChannelRows(value: unknown): NotifyChannelResultRow[] {
  if (!Array.isArray(value)) return [];
  const rows: NotifyChannelResultRow[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.channel !== "string") continue;
    rows.push({
      channel: item.channel,
      ok: item.ok === true,
      status: typeof item.status === "string" ? item.status : undefined,
      reason: typeof item.reason === "string" ? item.reason : undefined,
    });
  }
  return rows;
}

function skillTestNotifyDeliverySummary(call: SkillTestToolCallDetail) {
  const delivered = parseNotifyChannelRows(call.result_json?.delivered);
  const attempted = parseNotifyChannelRows(call.result_json?.attempted);
  const deliveredChannels = [
    ...new Set(
      delivered.filter((row) => row.ok !== false).map((row) => row.channel)
    ),
  ];
  const deliveredPart =
    deliveredChannels.length > 0
      ? `entregado por ${deliveredChannels.join(" + ")}`
      : null;

  const pushFailures = attempted.filter(
    (row) =>
      row.channel !== "web" &&
      !delivered.some((d) => d.channel === row.channel && d.ok !== false)
  );
  const failurePart =
    pushFailures.length > 0
      ? pushFailures
          .map((row) => {
            const reason = row.reason ?? row.status ?? "falló";
            return `${row.channel}: ${reason}`;
          })
          .join("; ")
      : null;

  if (deliveredPart && failurePart) {
    return `${deliveredPart} · no entregado: ${failurePart}`;
  }
  if (deliveredPart) return deliveredPart;
  if (failurePart) return `sin entrega push · ${failurePart}`;
  if (attempted.length > 0) {
    return `intentado por ${[...new Set(attempted.map((row) => row.channel))].join(" + ")}`;
  }
  return call.status;
}

/** Aviso cuando notify_user no entregó por un canal push esperado (p. ej. Telegram del asesor). */
export function skillTestNotifyUserNotice(
  calls: SkillTestToolCallDetail[]
): string | null {
  const notifyCalls = collectSkillTestNotifyUserCalls(calls).filter(
    (call) => call.status === "executed"
  );
  if (notifyCalls.length === 0) return null;

  const lines: string[] = [];
  for (const call of notifyCalls) {
    const attempted = parseNotifyChannelRows(call.result_json?.attempted);
    const delivered = parseNotifyChannelRows(call.result_json?.delivered);
    const failedPush = attempted.filter(
      (row) =>
        row.channel !== "web" &&
        !delivered.some((d) => d.channel === row.channel && d.ok !== false)
    );
    for (const row of failedPush) {
      if (row.channel === "telegram") {
        const reason = row.reason ?? row.status ?? "desconocido";
        lines.push(
          `Notify interno: Telegram del asesor no se entregó (${reason}). La bandeja web puede estar OK; revisa vinculación del bot y preferencias. En operación real también se perdería ese aviso push.`
        );
      } else {
        lines.push(
          `Notify interno: canal ${row.channel} no entregado (${row.reason ?? row.status ?? "falló"}).`
        );
      }
    }
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

function telegramTextDuplicateHint(
  call: SkillTestToolCallDetail,
  index: number,
  priorNormalized: string[]
) {
  const normalized = normalizeTelegramSendText(call.arguments_json?.text);
  if (!normalized) return null;
  const priorIndex = priorNormalized.findIndex(
    (value) => value && value === normalized
  );
  if (priorIndex >= 0 && priorIndex < index) {
    return `mismo texto normalizado que llamada #${priorIndex + 1}`;
  }
  const text =
    typeof call.arguments_json?.text === "string"
      ? call.arguments_json.text
      : "";
  return `text_len=${text.length}`;
}

export function SkillTestTelegramCallDetails({
  calls,
}: {
  calls: SkillTestToolCallDetail[];
}) {
  const telegramCalls = collectSkillTestTelegramCalls(calls);
  if (telegramCalls.length === 0) return null;

  const priorNormalized: string[] = [];
  const priorExecuted: SkillTestToolCallDetail[] = [];

  return (
    <div className="mt-2 space-y-1.5 rounded border border-violet-100 bg-violet-50/60 p-2 font-sans text-[10px] text-neutral-800">
      <p className="font-semibold text-violet-900">
        Telegram contacto externo — texto por llamada
      </p>
      <ol className="list-decimal space-y-2 pl-4">
        {telegramCalls.map((call, index) => {
          const at = call.finished_at ?? call.created_at;
          const purpose = call.arguments_json?.purpose;
          const chatId = call.arguments_json?.chat_id;
          const semanticDuplicate = skillTestTelegramCallIsSemanticDuplicate(
            call,
            priorExecuted
          );
          if (call.status === "executed") {
            priorExecuted.push(call);
          }
          const duplicateHint = telegramTextDuplicateHint(
            call,
            index,
            priorNormalized
          );
          priorNormalized.push(
            normalizeTelegramSendText(call.arguments_json?.text)
          );
          return (
            <li key={`${at ?? "na"}-${index}`}>
              <div className="font-semibold text-neutral-900">
                {formatSkillTestCallTimestamp(at)} ·{" "}
                {skillTestTelegramCallStatusLabel(call, { semanticDuplicate })}
                {typeof purpose === "string" && purpose.trim() ? (
                  <span className="font-normal text-neutral-600">
                    {" "}
                    · purpose={purpose.trim()}
                  </span>
                ) : null}
                {chatId != null ? (
                  <span className="font-normal text-neutral-500">
                    {" "}
                    · chat_id={String(chatId)}
                  </span>
                ) : null}
                {duplicateHint ? (
                  <span className="font-normal text-neutral-500">
                    {" "}
                    · {duplicateHint}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/80 p-1.5 text-neutral-700">
                {skillTestTelegramTextPreview(call.arguments_json?.text)}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SkillTestNotifyUserCallDetails({
  calls,
}: {
  calls: SkillTestToolCallDetail[];
}) {
  const notifyCalls = collectSkillTestNotifyUserCalls(calls);
  if (notifyCalls.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5 rounded border border-sky-100 bg-sky-50/60 p-2 font-sans text-[10px] text-neutral-800">
      <p className="font-semibold text-sky-900">
        Notify interno — entrega por llamada
      </p>
      <ol className="list-decimal space-y-2 pl-4">
        {notifyCalls.map((call, index) => {
          const at = call.finished_at ?? call.created_at;
          const kind = call.arguments_json?.kind;
          const urgency = call.arguments_json?.urgency;
          return (
            <li key={`${at ?? "na"}-${index}`}>
              <div className="font-semibold text-neutral-900">
                {formatSkillTestCallTimestamp(at)} ·{" "}
                {skillTestNotifyDeliverySummary(call)}
                {typeof kind === "string" && kind.trim() ? (
                  <span className="font-normal text-neutral-600">
                    {" "}
                    · kind={kind.trim()}
                  </span>
                ) : null}
                {typeof urgency === "string" && urgency.trim() ? (
                  <span className="font-normal text-neutral-500">
                    {" "}
                    · urgency={urgency.trim()}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/80 p-1.5 text-neutral-700">
                {skillTestTelegramTextPreview(call.arguments_json?.text)}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function distinctSkillTestToolNames(
  calls: Array<{ tool_name: string }>
): number {
  return new Set(calls.map((call) => call.tool_name)).size;
}

function telegramSendStats(calls: SkillTestToolCallDetail[]) {
  const telegramCalls = calls.filter(
    (call) => call.tool_name === "telegram_send_message_to_contact"
  );
  const executed = telegramCalls.filter((call) => call.status === "executed");
  const { realSends, backendDeduped, semanticDuplicates } =
    classifySkillTestTelegramSends(calls);
  return {
    telegramCalls,
    executed,
    realSends,
    deduped: backendDeduped,
    semanticDuplicates,
  };
}

export function skillTestTelegramNotice(
  calls: Array<SkillTestToolCallDetail>,
  scope: SkillTestTickScope = "habilidad"
): string | null {
  const { telegramCalls, executed, realSends, deduped, semanticDuplicates } =
    telegramSendStats(calls);
  if (telegramCalls.length === 0) return null;

  const pending = telegramCalls.filter(
    (call) => call.status === "pending_confirmation"
  ).length;
  const tickLabel = scope === "paso" ? "paso" : "habilidad";

  if (executed.length > 0) {
    const purposeSource =
      realSends.length > 0
        ? realSends
        : deduped.length > 0
          ? deduped
          : executed;
    const purposes = purposeSource
      .map((call) => {
        const purpose = call.arguments_json?.purpose;
        return typeof purpose === "string" && purpose.trim()
          ? purpose.trim()
          : null;
      })
      .filter((value): value is string => Boolean(value));
    const purposeHint =
      purposes.length > 0
        ? ` (${[...new Set(purposes)].join(", ")})`
        : "";
    const duplicateParts: string[] = [];
    if (deduped.length > 0) {
      duplicateParts.push(
        `${deduped.length} duplicada${deduped.length === 1 ? "" : "s"} sin reenvío (skipped_send)`
      );
    }
    if (semanticDuplicates.length > 0) {
      duplicateParts.push(
        `${semanticDuplicates.length} duplicada${
          semanticDuplicates.length === 1 ? "" : "s"
        } sin reenvío (mismo texto)`
      );
    }
    const duplicateHint =
      duplicateParts.length > 0 ? ` y ${duplicateParts.join("; ")}` : "";
    const lines = [
      `Telegram al contacto externo: ${realSends.length} envío${
        realSends.length === 1 ? "" : "s"
      } real${realSends.length === 1 ? "" : "es"}${duplicateHint} (${executed.length} llamada${
        executed.length === 1 ? "" : "s"
      } ejecutada${executed.length === 1 ? "" : "s"} en total) en este tick de ${tickLabel}${purposeHint}.`,
    ];
    if (realSends.length === 0 && executed.length > 0) {
      lines.push(
        "Atención: ningún envío real en este tick. Si el contacto debía recibir un mensaje nuevo, la deduplicación pudo bloquear todas las llamadas (p. ej. mismo texto que un envío previo en el turno). Confirma en Telegram."
      );
    } else if (
      deduped.length === 0 &&
      semanticDuplicates.length === 0 &&
      executed.length > 1
    ) {
      lines.push(
        "Hay más de una llamada ejecutada a Telegram con textos distintos; revisa el detalle por llamada."
      );
    }
    return lines.join(" ");
  }
  if (pending > 0) {
    return `Telegram: ${pending} mensaje${pending === 1 ? "" : "s"} preparado${
      pending === 1 ? "" : "s"
    } sin enviar (pendiente de confirmación).`;
  }
  return null;
}

export function skillTestExternalContactTelegramHint(
  calls: Array<SkillTestToolCallDetail>
): string | null {
  const hasTelegram = calls.some(
    (call) =>
      call.tool_name === "telegram_send_message_to_contact" &&
      (call.status === "executed" || call.status === "pending_confirmation")
  );
  if (!hasTelegram) return null;
  return "Mensaje dirigido al contacto externo (no es notify_user al asesor interno).";
}

export type RenderedDocumentLink = {
  signedUrl: string;
  downloadUrl: string | null;
  outputPath: string | null;
  outputBucket: string | null;
  templateSlug: string | null;
  format: string | null;
  callTimestamp?: string | null;
};

export function parseRenderedDocumentResult(
  result: unknown
): Omit<RenderedDocumentLink, "callTimestamp"> | null {
  if (!isPlainRecord(result)) return null;
  if (result.ok !== true) return null;
  if (result.skipped_render === true) return null;
  const status = typeof result.status === "string" ? result.status : "";
  if (status !== "rendered") return null;
  const signedUrl =
    typeof result.signed_url === "string" && result.signed_url.trim()
      ? result.signed_url.trim()
      : null;
  if (!signedUrl) return null;
  const outputPath =
    typeof result.output_path === "string" ? result.output_path : null;
  const outputBucket =
    typeof result.output_bucket === "string" ? result.output_bucket : null;
  const downloadUrl =
    outputPath && outputBucket
      ? `/api/tool-readiness/generated-document?bucket=${encodeURIComponent(
          outputBucket
        )}&path=${encodeURIComponent(outputPath)}`
      : null;
  return {
    signedUrl,
    downloadUrl,
    outputPath,
    outputBucket,
    templateSlug:
      typeof result.template_slug === "string" ? result.template_slug : null,
    format: typeof result.format === "string" ? result.format : null,
  };
}

function generateDocumentRenderStats(calls: SkillTestToolCallDetail[]) {
  const docCalls = calls.filter(
    (call) => call.tool_name === "generate_document_from_template"
  );
  const executed = docCalls.filter((call) => call.status === "executed");
  const dedupOptions = skillTestDocumentDedupOptions(calls);
  const realRenders = executed.filter(
    (call) => call.result_json?.skipped_render !== true
  );
  const deduped = executed.filter(
    (call) => call.result_json?.skipped_render === true
  );
  const priorRendered: SkillTestToolCallDetail[] = [];
  const semanticDuplicates: SkillTestToolCallDetail[] = [];
  for (const call of realRenders) {
    if (
      skillTestGenerateDocumentIsSemanticDuplicate(
        call,
        priorRendered,
        dedupOptions
      )
    ) {
      semanticDuplicates.push(call);
    } else {
      priorRendered.push(call);
    }
  }
  return { effectiveRenders: priorRendered, deduped, semanticDuplicates, executed };
}

export function collectSkillTestRenderedDocuments(
  calls: SkillTestToolCallDetail[]
): RenderedDocumentLink[] {
  const documents: RenderedDocumentLink[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.tool_name !== "generate_document_from_template") continue;
    if (call.status !== "executed") continue;
    if (call.result_json?.skipped_render === true) continue;
    const parsed = parseRenderedDocumentResult(call.result_json);
    if (!parsed) continue;
    const dedupeKey = parsed.outputPath ?? parsed.signedUrl;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    documents.push({
      ...parsed,
      callTimestamp: call.finished_at ?? call.created_at ?? null,
    });
  }
  return documents;
}

export function skillTestNotifyMissingDocUrlNotice(
  calls: SkillTestToolCallDetail[],
  documents: RenderedDocumentLink[]
): string | null {
  if (documents.length === 0) return null;
  const hasPlaceholder = collectSkillTestNotifyUserCalls(calls).some((call) => {
    if (call.status !== "executed") return false;
    const text = call.arguments_json?.text;
    return typeof text === "string" && text.includes("[doc_url]");
  });
  if (!hasPlaceholder) return null;
  return (
    "El notify_user incluyó el placeholder [doc_url] sin sustituir por el enlace real. " +
    "En operación, pega la URL del borrador (abajo) en el mensaje al asesor."
  );
}

export function SkillTestRenderedDocumentLinks({
  documents,
  tone = "violet",
}: {
  documents: RenderedDocumentLink[];
  tone?: "violet" | "indigo" | "emerald";
}) {
  if (documents.length === 0) return null;
  const shell =
    tone === "indigo"
      ? "border-indigo-200 bg-indigo-50/80 text-indigo-950"
      : tone === "emerald"
        ? "border-emerald-200 bg-emerald-50/40 text-emerald-950"
        : "border-violet-200 bg-violet-50/60 text-violet-950";
  const linkClass =
    tone === "indigo"
      ? "text-indigo-900"
      : tone === "emerald"
        ? "text-emerald-900"
        : "text-violet-900";

  return (
    <div className={`space-y-2 rounded border p-2 font-sans text-[11px] ${shell}`}>
      <p className="font-semibold">Borrador generado (DOCX)</p>
      <ol className="list-decimal space-y-2 pl-4">
        {documents.map((doc, index) => (
          <li key={`${doc.outputPath ?? doc.signedUrl}-${index}`}>
            <div className="flex flex-wrap items-center gap-2">
              {doc.downloadUrl ? (
                <a
                  href={doc.downloadUrl}
                  className={`font-semibold underline-offset-2 hover:underline ${linkClass}`}
                >
                  Descargar DOCX
                </a>
              ) : null}
              <a
                href={doc.signedUrl}
                target="_blank"
                rel="noreferrer"
                className={`underline-offset-2 hover:underline ${linkClass}`}
              >
                Abrir en navegador
              </a>
              {doc.format ? (
                <span className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[10px] uppercase">
                  {doc.format}
                </span>
              ) : null}
              {doc.templateSlug ? (
                <span className="text-neutral-600">plantilla: {doc.templateSlug}</span>
              ) : null}
            </div>
            {doc.callTimestamp ? (
              <p className="mt-0.5 text-neutral-600">
                {formatSkillTestCallTimestamp(doc.callTimestamp)}
              </p>
            ) : null}
            {doc.outputPath ? (
              <p className="mt-0.5 break-all font-mono text-[10px] text-neutral-500">
                {doc.outputPath}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="text-neutral-600">
        Enlace firmado (~1 h). Si caducó, vuelve a ejecutar la prueba para regenerarlo.
      </p>
    </div>
  );
}

export function SkillTestGenerateDocumentCallDetails({
  calls,
}: {
  calls: SkillTestToolCallDetail[];
}) {
  const documents = collectSkillTestRenderedDocuments(calls);
  if (documents.length === 0) {
    const attempted = calls.filter(
      (call) =>
        call.tool_name === "generate_document_from_template" &&
        call.status === "executed"
    );
    if (attempted.length === 0) return null;
    return (
      <p className="mt-2 rounded border border-amber-200 bg-amber-50/90 p-2 text-[10px] text-amber-950">
        generate_document_from_template se ejecutó sin enlace firmado en el resultado
        (prueba anterior al soporte de signed_url). Vuelve a probar la tool o la
        habilidad para obtener un enlace de descarga.
      </p>
    );
  }
  return (
    <div className="mt-2">
      <SkillTestRenderedDocumentLinks documents={documents} />
    </div>
  );
}

export function formatSkillTestCallGroupLabel(params: {
  label: string;
  calls: Array<{
    tool_name: string;
    status: string;
    result_json?: Record<string, unknown>;
  }>;
  executedCount: number;
  pendingCount?: number;
}): string {
  const { label, calls, executedCount, pendingCount = 0 } = params;
  const distinctTools = distinctSkillTestToolNames(calls);
  const callWord = calls.length === 1 ? "llamada" : "llamadas";
  const toolWord = distinctTools === 1 ? "tool" : "tools";
  let statusPart =
    pendingCount > 0
      ? `${executedCount + pendingCount}/${calls.length} preparadas (${pendingCount} sin enviar)`
      : `${executedCount}/${calls.length} ejecutadas`;

  const { realSends, deduped, semanticDuplicates, executed } = telegramSendStats(
    calls as SkillTestToolCallDetail[]
  );
  if (executed.length > 0 && label === "Negocio") {
    const dupNote =
      deduped.length > 0 || semanticDuplicates.length > 0
        ? `, ${deduped.length + semanticDuplicates.length} dup.`
        : "";
    statusPart += ` · Telegram: ${realSends.length} envío${
      realSends.length === 1 ? "" : "s"
    } real${dupNote}`;
  }

  const docStats = generateDocumentRenderStats(calls as SkillTestToolCallDetail[]);
  if (docStats.executed.length > 0 && label === "Negocio") {
    const dupCount = docStats.deduped.length + docStats.semanticDuplicates.length;
    const docDupNote =
      dupCount > 0
        ? `, ${dupCount} dup.`
        : "";
    statusPart += ` · DOCX: ${docStats.effectiveRenders.length} render${
      docStats.effectiveRenders.length === 1 ? "" : "s"
    } efectivo${docDupNote}`;
  }

  return `${label} — ${calls.length} ${callWord}, ${distinctTools} ${toolWord} distintas (${statusPart})`;
}

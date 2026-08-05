// Driver headless del walkthrough E2E de property_optioning (Phase 4 exit
// check, capa scripts). Espeja la orquestación del lab
// (/api/operational-case-tests + /run) usando LOS MISMOS building blocks de
// producción: createOperationalCase pinneado, runSettingsTestCaseAgentTick,
// associateExternalResponseWithCase, merge determinista de características y
// replay-evidencia por corrida. Si el route del lab cambia, revisar drift.
//
// Uso (desde apps/web):
//   npx tsx scripts/e2e-property-optioning.ts create [--user <uuid>]
//     add --fresh to avoid reusing history/impact rows from a prior run
//   npx tsx scripts/e2e-property-optioning.ts status
//   npx tsx scripts/e2e-property-optioning.ts tick [--owner "<texto>"]
//   npx tsx scripts/e2e-property-optioning.ts owner-docs "<texto respuesta dueño>"
//   npx tsx scripts/e2e-property-optioning.ts replay
//
// El caso es test_mode (case_type_settings_test): el cron v1 lo ignora y el
// chat del "dueño" usa el sentinel de Telegram del lab (sin envíos reales).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvIntoProcess(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const key = line.slice(0, idx).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// Env ANTES de importar módulos que leen process.env.
loadEnvIntoProcess(resolve(__dirname, "..", ".env.local"));

const CASE_TYPE = "property_optioning";

function arg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  const command = process.argv[2] ?? "status";

  const {
    createServerClient,
    createOperationalCase,
    createWorkItemsFromTemplates,
    getOperationalCase,
    getLatestPublishedDefinitionForUser,
    getPublishedDefinition,
    insertOperationalCaseEvent,
    markCaseProcessing,
    associateExternalResponseWithCase,
    expireExternalContactNotificationsForCase,
    listWorkItemsForCase,
    listCaseFacts,
    listCaseArtifactsForCase,
    listCaseApprovalsForCase,
    propagateReadiness,
  } = await import("@agents/db");
  const db = createServerClient();

  async function resolveUserId(): Promise<string> {
    const explicit = arg("--user");
    if (explicit) return explicit;
    const { data, error } = await db
      .from("operational_cases")
      .select("user_id")
      .eq("case_type", CASE_TYPE)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) throw new Error("no property_optioning cases found; pass --user");
    return top[0];
  }

  const userId = await resolveUserId();

  async function findTestCase() {
    const { findLatestSettingsTestCase } = await import(
      "../src/lib/operational-cases/settings-test-case-lookup"
    );
    const { data, error } = await db
      .from("operational_case_types")
      .select("id, case_type, display_name, status, visibility, user_id, intake_schema_jsonb")
      .eq("case_type", CASE_TYPE)
      .eq("status", "active")
      .order("visibility", { ascending: false }) // global primero
      .limit(5);
    if (error) throw error;
    const caseType = (data ?? []).find(
      (ct) => ct.visibility === "global" || ct.user_id === userId
    );
    if (!caseType) throw new Error("active property_optioning case type not found");
    const existing = await findLatestSettingsTestCase(
      db,
      userId,
      caseType.id,
      caseType.case_type
    );
    return { caseType, existing };
  }

  if (command === "create") {
    const { buildTestContext } = await import(
      "../src/app/api/operational-case-tests/test-context-samples"
    );
    const { settingsTestPropertyDataSeed } = await import(
      "../src/lib/operational-cases/property-search-zone"
    );
    const { syncLabFormIntoPropertyData } = await import(
      "../src/lib/operational-cases/lab-form-property-data-sync"
    );
    const { caseType, existing } = await findTestCase();
    const fields = Array.isArray(caseType.intake_schema_jsonb)
      ? (caseType.intake_schema_jsonb as import("@agents/types").OperationalCaseIntakeField[])
      : [];
    const context: Record<string, unknown> = {
      ...buildTestContext(fields, caseType.case_type),
      title: `${caseType.display_name} - prueba`,
      created_from: "case_type_settings_test",
      test_mode: true,
      publication_mode: "active",
      case_type_id: caseType.id,
    };
    context.property_data = syncLabFormIntoPropertyData({
      formContext: context,
      propertyData: settingsTestPropertyDataSeed(context),
    }).propertyData;
    const externalName =
      String(context.owner_name ?? "").trim() || "Contacto de prueba";
    const telegramChatId = Number(context.telegram_chat_id);

    const latest = await getLatestPublishedDefinitionForUser(
      db,
      userId,
      caseType.case_type
    );
    const pinned = latest ? { id: latest.id, version: latest.version } : null;
    if (!pinned) throw new Error("no published definition to pin");

    if (existing && !process.argv.includes("--fresh")) {
      const { data, error } = await db
        .from("operational_cases")
        .update({
          context_jsonb: {
            ...context,
            controlled_test_playthrough_anchor_at: new Date().toISOString(),
          },
          external_contact_jsonb: {
            display_name: externalName,
            channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
            chat_id: Number.isFinite(telegramChatId) ? telegramChatId : undefined,
          },
          status: "active",
          current_step: "intake",
          workflow_definition_id: pinned.id,
          workflow_definition_version: pinned.version,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      await insertOperationalCaseEvent(db, {
        caseId: existing.id,
        eventType: "human_decision",
        actor: "user",
        payload: {
          source: "case_type_settings_test_regenerate",
          test_mode: true,
          note: "Regenerado por el driver E2E headless.",
        },
      });
      console.log(
        `regenerated case=${data.id} def=v${pinned.version} step=${data.current_step} status=${data.status}`
      );
    } else {
      const opCase = await createOperationalCase(db, {
        userId,
        caseTypeId: caseType.id,
        caseType: caseType.case_type,
        status: "active",
        currentStep: "intake",
        nextActionAt: null,
        externalContact: {
          display_name: externalName,
          channel: Number.isFinite(telegramChatId) ? "telegram" : undefined,
          chat_id: Number.isFinite(telegramChatId) ? telegramChatId : undefined,
        },
        context: {
          ...context,
          controlled_test_playthrough_anchor_at: new Date().toISOString(),
        },
        workflowDefinition: pinned,
      });
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "state_changed",
        actor: "user",
        payload: {
          source: "case_type_settings_test",
          status: opCase.status,
          current_step: opCase.current_step,
          test_mode: true,
        },
      });
      console.log(
        `created case=${opCase.id} def=v${pinned.version} step=${opCase.current_step} status=${opCase.status}`
      );
    }
    return;
  }

  const { existing } = await findTestCase();
  if (!existing) throw new Error("no settings test case; run `create` first");
  const caseId = existing.id;

  if (command === "work-sync") {
    const opCase = await getOperationalCase(db, caseId);
    if (
      !opCase ||
      !opCase.current_step ||
      !opCase.workflow_definition_id ||
      opCase.workflow_definition_version == null
    ) {
      throw new Error("case has no current step or pinned definition");
    }
    const definition = await getPublishedDefinition(
      db,
      opCase.workflow_definition_id,
      opCase.workflow_definition_version
    );
    if (!definition) throw new Error("pinned published definition not found");
    const templates = definition.graph_jsonb.work_templates.flatMap(
      (template) =>
        template.on_enter_state === opCase.current_step &&
        template.required_capability
          ? [
              {
                work_type: template.work_type,
                required_capability: template.required_capability,
                depends_on: template.depends_on,
                verification_contract: template.verification_contract,
              },
            ]
          : []
    );
    const result = await createWorkItemsFromTemplates(db, {
      userId,
      caseId,
      workflowDefinitionVersion: definition.version,
      onEnterState: opCase.current_step,
      templates,
    });
    const readiness = await propagateReadiness(db, { userId, caseId });
    console.log(
      `work-sync step=${opCase.current_step}: templates=${templates.length} created=${result.created.length} existing=${result.existing.length} ready=${readiness.readyIds.length}`
    );
    return;
  }

  if (command === "work-run") {
    const { runWorkPlaneCronPass } = await import(
      "../src/lib/operational-cases/work-plane-tick"
    );
    const summary = await runWorkPlaneCronPass(db, {
      onlyUserId: userId,
      onlyCaseId: caseId,
      maxItemsPerTenant: 5,
      runnerRef: `property-optioning-e2e:${Date.now()}`,
      retryBackoffMs: () => 0,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === "status") {
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase) throw new Error("case disappeared");
    console.log(
      `case=${opCase.id}\n  step=${opCase.current_step} status=${opCase.status} def=${opCase.workflow_definition_version != null ? `v${opCase.workflow_definition_version}` : "(none)"} next_action=${opCase.next_action_at ?? "-"}`
    );
    const ctx = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
    console.log(
      `  controlled_test_status=${ctx.controlled_test_status ?? "-"} intake_status=${ctx.intake_status ?? "-"}`
    );
    const { data: events } = await db
      .from("operational_case_events")
      .select("event_type, actor, created_at, payload_jsonb")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(10);
    console.log("  últimos eventos:");
    for (const ev of (events ?? []).reverse()) {
      const p = (ev.payload_jsonb ?? {}) as Record<string, unknown>;
      const from = (p.from as Record<string, unknown>)?.current_step;
      const to = (p.to as Record<string, unknown>)?.current_step;
      const move = from || to ? ` ${from ?? "?"}→${to ?? "?"}` : "";
      console.log(
        `    ${String(ev.created_at).slice(11, 19)} ${ev.event_type}(${ev.actor ?? "-"})${move} ${p.kind ?? p.source ?? ""}`
      );
    }
    const { data: pendingTools } = await db
      .from("tool_calls")
      .select("id, tool_name, status")
      .eq("status", "pending_confirmation")
      .contains("arguments_json", { case_id: caseId });
    if (pendingTools?.length) {
      console.log("  tools pendientes de confirmación:");
      for (const t of pendingTools) console.log(`    ${t.tool_name} (${t.id})`);
    }
    const { data: notifications } = await db
      .from("internal_user_notifications")
      .select("kind, status, created_at")
      .eq("case_id", caseId)
      .eq("status", "unread")
      .order("created_at", { ascending: false })
      .limit(5);
    if (notifications?.length) {
      console.log("  notificaciones sin leer:");
      for (const n of notifications) console.log(`    ${n.kind}`);
    }
    const [workItems, facts, artifacts, approvals] = await Promise.all([
      listWorkItemsForCase(db, userId, caseId),
      listCaseFacts(db, userId, caseId, { limit: 200 }),
      listCaseArtifactsForCase(db, userId, caseId),
      listCaseApprovalsForCase(db, userId, caseId),
    ]);
    console.log(
      `  work_items=${workItems.length} [${workItems.map((w) => `${w.work_type}:${w.status}`).join(", ")}]`
    );
    console.log(
      `  facts=${facts.length} artifacts=${artifacts.length} [${artifacts.map((a) => `${a.artifact_type}:${a.status}`).join(", ")}] approvals=${approvals.length}`
    );
    return;
  }

  if (command === "tick") {
    const ownerResponseText = arg("--owner")?.trim() || undefined;
    let fresh = await getOperationalCase(db, caseId);
    if (!fresh) throw new Error("case disappeared");
    if (ownerResponseText) {
      await expireExternalContactNotificationsForCase(db, caseId);
      const chatId = fresh.external_contact_jsonb?.chat_id;
      if (typeof chatId !== "number") throw new Error("missing external chat_id");
      const awakened = await associateExternalResponseWithCase(db, {
        caseId,
        channel: "telegram",
        chatId,
        payload: {
          source: "readiness_owner_simulation",
          simulated: true,
          text: ownerResponseText,
          received_at: new Date().toISOString(),
        },
      });
      if (!awakened) throw new Error("owner_response_not_registered");
      fresh = (await getOperationalCase(db, caseId)) ?? fresh;
    }
    const locked = await markCaseProcessing(db, fresh.id, fresh.version, 1);
    if (!locked) throw new Error("case_busy (lease activo)");
    const reloaded = await getOperationalCase(db, caseId);
    if (!reloaded) throw new Error("case disappeared after lock");

    const { runSettingsTestCaseAgentTick } = await import(
      "../src/lib/operational-cases/run-settings-test-case-tick"
    );
    const tick = await runSettingsTestCaseAgentTick(db, reloaded, userId, {
      source: "case_type_settings",
      skipLock: true,
      ownerResponseText,
    });
    console.log(
      `tick done: ${reloaded.current_step}→${tick.case.current_step} status=${tick.case.status} pending_confirmation=${tick.pending_confirmation}`
    );
    if (tick.pendingConfirmation) {
      console.log(
        `  pending tool: ${tick.pendingConfirmation.toolName ?? "?"} id=${tick.pendingConfirmation.toolCallId}`
      );
    }
    if (tick.response_preview) {
      console.log(`  preview: ${tick.response_preview.slice(0, 500)}`);
    }
    const { replayDefinitionForCase } = await import(
      "../src/lib/operational-cases/replay-definition"
    );
    try {
      const replay = await replayDefinitionForCase(db, caseId, {
        recordEvidence: true,
        gate: "lab_run_replay",
      });
      if (replay) {
        console.log(
          `  replay: terminal_match=${replay.result.ok} divergencias=${replay.result.divergences.length} huecos=${replay.result.unrecordedGaps} evidence=${replay.evidenceId}`
        );
      }
    } catch (error) {
      console.warn("  replay evidence failed:", error);
    }
    return;
  }

  if (command === "owner-docs") {
    // Simulación de la respuesta de características del dueño (paso
    // documents_received) — espejo del camino determinista del route.
    const text = process.argv[3]?.trim();
    if (!text) throw new Error('usage: owner-docs "<texto>"');
    const { updateOperationalCase } = await import("@agents/db");
    const {
      buildPropertyDataReviewMessage,
      missingOwnerResponseCriticalFields,
      parseOwnerCharacteristics,
      syncIntakeFieldsFromPropertyData,
    } = await import("../src/lib/operational-cases/parse-owner-characteristics");
    const { createAdvisedCaseUpdate } = await import(
      "../src/lib/operational-cases/advised-case-update"
    );
    const { notify } = await import("../src/lib/notify");
    const { recordCaseFactsAndApplyImpact } = await import("@agents/agent");
    const advisedOwnerSimulationUpdate = createAdvisedCaseUpdate(
      "lab_owner_simulation",
      "runtime"
    );

    let fresh = await getOperationalCase(db, caseId);
    if (!fresh) throw new Error("case disappeared");
    await expireExternalContactNotificationsForCase(db, caseId);
    if (fresh.current_step !== "documents_received") {
      // Teleport de fixture deliberado (S1.6): no es la transición bajo prueba.
      const prepared = await updateOperationalCase(db, fresh.id, fresh.version, {
        currentStep: "documents_received",
        status: "waiting_external",
        nextActionAt: null,
        context: {
          ...(fresh.context_jsonb ?? {}),
          test_mode: true,
          controlled_test_prepared_step: "documents_received",
          controlled_test_prepared_at: new Date().toISOString(),
        },
      });
      if (!prepared) throw new Error("case_prepare_failed");
      fresh = prepared;
      await insertOperationalCaseEvent(db, {
        caseId,
        eventType: "state_changed",
        actor: "system",
        payload: {
          source: "readiness_owner_simulation",
          current_step: "documents_received",
          status: "waiting_external",
          note: "Caso preparado para simular respuesta de características del dueño.",
        },
      });
    }
    const chatId = fresh.external_contact_jsonb?.chat_id;
    if (typeof chatId !== "number") throw new Error("missing external chat_id");
    const awakened = await associateExternalResponseWithCase(db, {
      caseId,
      channel: "telegram",
      chatId,
      payload: {
        source: "readiness_owner_simulation",
        simulated: true,
        text,
        received_at: new Date().toISOString(),
      },
    });
    if (!awakened) throw new Error("owner_response_not_registered");
    fresh = (await getOperationalCase(db, caseId)) ?? fresh;

    const currentContext = (fresh.context_jsonb ?? {}) as Record<string, unknown>;
    const currentPropertyData =
      currentContext.property_data &&
      typeof currentContext.property_data === "object" &&
      !Array.isArray(currentContext.property_data)
        ? (currentContext.property_data as Record<string, unknown>)
        : {};
    const parsed = parseOwnerCharacteristics(text);
    const propertyData = { ...currentPropertyData, ...parsed };
    const criticalMissing = missingOwnerResponseCriticalFields(propertyData);
    const mergedContext = syncIntakeFieldsFromPropertyData(
      currentContext,
      propertyData
    );
    const updated = await advisedOwnerSimulationUpdate(db, fresh, fresh.version, {
      currentStep: "documents_received",
      status: criticalMissing.length === 0 ? "waiting_internal" : "waiting_external",
      nextActionAt: null,
      context: {
        ...mergedContext,
        controlled_test_status:
          criticalMissing.length === 0
            ? "owner_response_processed_waiting_internal"
            : "owner_response_processed_missing_fields",
        controlled_test_owner_response_processed_at: new Date().toISOString(),
        controlled_test_owner_response_parsed_fields: Object.keys(parsed),
      },
    });
    if (!updated) throw new Error("owner_response_deterministic_update_failed");

    await recordCaseFactsAndApplyImpact(db, {
      userId: fresh.user_id,
      opCase: updated,
      factPatch: parsed,
      factKeyPrefix: "property.",
      sourceKind: "external_contact",
      sourceRef: "readiness_owner_simulation",
    });

    if (criticalMissing.length === 0) {
      const reviewText = buildPropertyDataReviewMessage({
        propertyTitle: String(currentContext.title ?? "la propiedad"),
        propertyData,
      });
      const notifyResult = await notify(
        db,
        fresh.user_id,
        {
          text: reviewText,
          kind: "property_data_review",
          data: {
            case_id: updated.id,
            title: "Revisión de datos de propiedad",
            source: "readiness_owner_simulation",
          },
        },
        "normal"
      );
      await insertOperationalCaseEvent(db, {
        caseId: updated.id,
        eventType: "human_decision",
        actor: "system",
        payload: {
          kind: "property_data_review_requested",
          source: "readiness_owner_simulation",
          notify_delivered: notifyResult.delivered,
        },
      });
      console.log(
        `owner-docs merged: parsed=[${Object.keys(parsed).join(", ")}] critical_missing=0 → waiting_internal (revisión interna notificada: ${notifyResult.delivered.join(",") || "ninguna"})`
      );
    } else {
      console.log(
        `owner-docs merged parcialmente: parsed=[${Object.keys(parsed).join(", ")}] critical_missing=[${criticalMissing.join(", ")}] → waiting_external`
      );
    }
    await insertOperationalCaseEvent(db, {
      caseId: updated.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        source: "readiness_owner_simulation",
        kind: "owner_response_deterministic_merge",
        parsed_fields: Object.keys(parsed),
        critical_missing: criticalMissing,
        status: updated.status,
        current_step: updated.current_step,
      },
    });
    return;
  }

  if (command === "decide") {
    // Turno de decisión del broker por el camino REAL de producción:
    // resolveDecomposedPendingDecisionTurn (multiplexer 4.1 + cadena de gates).
    const text = process.argv[3]?.trim();
    if (!text) throw new Error('usage: decide "<texto>"');
    const { resolveDecomposedPendingDecisionTurn } = await import(
      "../src/lib/business-decisions/decomposed-turn"
    );
    const turn = await resolveDecomposedPendingDecisionTurn(db, {
      userId,
      text,
      channel: "web",
    });
    if (!turn.handled) {
      console.log("decide: handled=false (el turno caería al agente)");
      return;
    }
    console.log(
      `decide: routed=${turn.routed} ok=${turn.ok} status=${turn.status ?? "-"} case=${turn.caseId ?? "-"}`
    );
    console.log(`  message: ${turn.message.slice(0, 600)}`);
    if (turn.residual?.text) {
      console.log(`  residual (${turn.residual.reason}): ${turn.residual.text}`);
    }
    if (turn.runAfterReply) {
      console.log("  ejecutando runAfterReply…");
      await turn.runAfterReply();
      console.log("  runAfterReply listo");
    }
    return;
  }

  if (command === "replay") {
    const { replayDefinitionForCase } = await import(
      "../src/lib/operational-cases/replay-definition"
    );
    const outcome = await replayDefinitionForCase(db, caseId, {
      recordEvidence: false,
    });
    if (!outcome) throw new Error("case not pinned");
    console.log(
      `replay def=v${outcome.definitionVersion}: terminal_match=${outcome.result.ok} terminal=${outcome.result.terminalStep} esperado=${outcome.result.expectedTerminalStep} transiciones=${outcome.result.transitions.length} divergencias=${outcome.result.divergences.length} huecos=${outcome.result.unrecordedGaps}`
    );
    for (const d of outcome.result.divergences) {
      console.log(`  · ${d.from ?? "(inicio)"}→${d.to} (${d.reason ?? d.failedGuards.join(",")})`);
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

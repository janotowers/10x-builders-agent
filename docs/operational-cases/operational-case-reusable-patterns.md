# Catálogo de patrones reutilizables — Casos operacionales

> **Estado:** v1.1 — catálogo operativo derivado del piloto `property_optioning` (Pasos 2–5; N4 Paso 5 con HITL de contrato completo).
>
> **Documentos relacionados**
> - [`use-case-authoring-vision.md`](use-case-authoring-vision.md) — visión NL → propuesta implementable (hub).
> - [`authoring-playbook.md`](authoring-playbook.md) — modelo `step_key` / `status` / habilidad raíz.
> - [`testing-framework.md`](testing-framework.md) — marco N0–N5 y matrices de prueba.
> - [`../skills-tools-architecture.md`](../skills-tools-architecture.md) §11 — resumen UI readiness.
> - Código machine-readable: [`apps/web/src/lib/operational-cases/test-patterns-catalog.ts`](../../apps/web/src/lib/operational-cases/test-patterns-catalog.ts)

---

## 1. Propósito

Este documento **nominaliza** patrones que hoy están repartidos entre runtime del agente, APIs de readiness y UI. Sirve para:

1. **Autoría** de nuevos tipos de caso (humana o asistida por NL).
2. **Pruebas** reproducibles (N0–N5) sin rediseñar cada vez.
3. **Generación futura** de `testPlan` y metadata `test_pattern` en el flow (anillo 2–3 de la visión).

**No reemplaza** [`testing-framework.md`](testing-framework.md) (niveles N0–N5) ni [`authoring-playbook.md`](authoring-playbook.md) (modelo de dominio). Lo complementa con **IDs estables** (`PATTERN_*`, `n2_*`).

---

## 2. Cómo leer una ficha de patrón

| Campo | Significado |
|-------|-------------|
| **ID** | Identificador estable para docs, `test-patterns-catalog.ts` y propuestas NL |
| **Capa** | `runtime` \| `test_contract` \| `test_ui` \| `test_n2` |
| **Cuándo usar** | Condición de negocio o de QA |
| **Implementación** | Archivos en el repo |
| **Producción vs prueba** | Si aplica solo en caso `case_type_settings_test` |
| **Relacionado** | Otros IDs o niveles N |

---

## 3. Patrones de runtime (agente / servidor)

### `PATTERN_TELEGRAM_DEDUP_SAME_TURN`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Cualquier tick donde el modelo pueda invocar `telegram_send_message_to_contact` más de una vez con el mismo texto/chat/purpose |
| **Implementación** | [`packages/types/src/telegram-send-dedup.ts`](../../packages/types/src/telegram-send-dedup.ts), [`packages/agent/src/tools/realestate-adapters.ts`](../../packages/agent/src/tools/realestate-adapters.ts) |
| **Comportamiento** | Primera llamada envía; siguientes equivalentes en el mismo turno reciben `skipped_send: true` en `result_json` |
| **Producción** | Sí — protege al contacto externo en cron y en pruebas |

### `PATTERN_NOTIFY_USER_CHANNELS`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Avisos al **asesor interno** (`notify_user`), no al contacto externo |
| **Implementación** | [`apps/web/src/lib/notify/index.ts`](../../apps/web/src/lib/notify/index.ts), wrapper en [`operational-cases-adapters.ts`](../../packages/agent/src/tools/operational-cases-adapters.ts) |
| **Comportamiento** | Siempre persiste en **web** (inbox). Push según `user_notification_preferences.channels_priority_jsonb`. Urgencia `normal`: primer canal push exitoso; `high`: todos los habilitados. Reintento 1× en Telegram si falla envío |
| **Producción** | Sí |
| **Observabilidad** | `result_json.delivered` vs `attempted`; ver `PATTERN_SKILL_TEST_CALL_DETAILS` |

### `PATTERN_CASE_UPDATE_STATE_OPTIMISTIC_RETRY`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Varias `operational_case_update_state` en paralelo en el mismo tick |
| **Implementación** | [`packages/agent/src/tools/operational-cases-adapters.ts`](../../packages/agent/src/tools/operational-cases-adapters.ts) |
| **Comportamiento** | Bloqueo por `expected_version`; si la versión cambió por una llamada hermana, **relee y reintenta una vez** antes de fallar |
| **Producción** | Sí |

### `PATTERN_SETTINGS_TEST_SEED_AND_REPAIR`

| | |
|--|--|
| **Capa** | `runtime` (solo readiness) |
| **Cuándo usar** | N3 en Ajustes cuando el escenario de prueba requiere estado/artefacto conocido y el agente pisa `context_jsonb` |
| **Implementación** | Semilla/reparación en [`run-skill/route.ts`](../../apps/web/src/app/api/tool-readiness/run-skill/route.ts) (p. ej. `extract-property-characteristics`, `prepare-listing-price`) |
| **Producción** | **No** — solo casos con `created_from: case_type_settings_test` |
| **Ejemplo** | Completar `bedrooms`/`bathrooms`/`parking_spots` tras tick N3 de revisión interna |

---

## 4. Patrones de contrato de prueba (N3 / N4)

### `PATTERN_SKILL_TEST_CONTRACT`

| | |
|--|--|
| **Capa** | `test_contract` |
| **Cuándo usar** | Cada habilidad atómica con comportamiento distinto por escenario |
| **Implementación** | `test_contract` en `operational_flow_jsonb.step_skills[]` (playbook); fallback en `SKILL_TEST_CONTRACTS` en [`run-skill/route.ts`](../../apps/web/src/app/api/tool-readiness/run-skill/route.ts) |
| **Campos clave** | `expected_tool_calls`, `expected_internal_tool_calls`, `expected_events`, `expected_context_keys`, `optional_tool_calls` |
| **Nivel** | N3 |

### `PATTERN_STEP_TEST_SCENARIO`

| | |
|--|--|
| **Capa** | `test_contract` |
| **Cuándo usar** | Paso con **2+ ramas** de negocio (p. ej. revisión interna vs faltantes al externo) |
| **Implementación** | Fuente única [`step-test-scenario-registry.ts`](../../apps/web/src/lib/operational-cases/step-test-scenario-registry.ts): metadata UI, semilla, expectativa, mensaje y ejecución. [`step-test-scenarios.ts`](../../apps/web/src/lib/operational-cases/step-test-scenarios.ts) queda como capa compat de UI. |
| **Ejecución** | Async durable: `operational_case_test_runs` guarda `queued/running/completed/failed` y `turn_id`; `run-step` devuelve `run_id` y la UI hace polling. El endpoint de estado expone `tool_calls` parciales (última tool, estado, duración) mientras los eventos del caso siguen siendo append-only para auditoría. |
| **Nivel** | N4 v1 (un tick, habilidad raíz forzada) |

### `PATTERN_SKILL_TEST_PROMPT_GUARDRAILS`

| | |
|--|--|
| **Capa** | `test_contract` |
| **Cuándo usar** | Mensaje de prueba controlada en `buildSkillTestMessage` / escenario N4 |
| **Reglas típicas** | Máximo **una** `telegram_send_message_to_contact` por tick; `notify_user` obligatorio antes de `property_data_review`; no pedir dormitorios en paso `awaiting_documents`; merge de `property_data` sin borrar campos críticos |
| **Implementación** | [`run-skill/route.ts`](../../apps/web/src/app/api/tool-readiness/run-skill/route.ts), [`run-step/route.ts`](../../apps/web/src/app/api/tool-readiness/run-step/route.ts) |

---

## 5. Patrones de UI readiness (N3 / N4)

### `PATTERN_SKILL_TEST_CALL_DETAILS`

| | |
|--|--|
| **Capa** | `test_ui` |
| **Cuándo usar** | Siempre que se muestre resultado de **Probar habilidad** o **Probar paso** |
| **Implementación** | [`apps/web/src/lib/operational-cases/skill-test-call-details.tsx`](../../apps/web/src/lib/operational-cases/skill-test-call-details.tsx) |
| **Presenta** | Aviso Telegram externo (envíos reales vs duplicadas); detalle por llamada (`purpose`, `text_len`, texto normalizado); bloque **Notify interno** (canales + fallos en `attempted`); etiquetas Negocio / Persistencia |
| **No hace** | Ejecutar agente ni escribir en BD — interpreta `tool_calls` devueltas por APIs |

### `PATTERN_NOTIFY_DELIVERY_WARNING`

| | |
|--|--|
| **Capa** | `test_ui` |
| **Cuándo usar** | `notify_user` ejecutada pero Telegram del asesor no en `delivered` |
| **Implementación** | `skillTestNotifyUserNotice()` en el mismo módulo; aviso ámbar en Preparación operativa |

### `PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS`

| | |
|--|--|
| **Capa** | `test_ui` |
| **Cuándo usar** | Siempre que un paso declare tools *readiness-visible* en `step_skills` / `step_tools` |
| **Comportamiento** | **N3** deshabilitado si la habilidad está `blocked_by_tools`. **N4** deshabilitado si el paso está `blocked` o alguna habilidad del paso está `blocked_by_tools`. Misma condición en API (`run-skill`, `run-step`) usando `readinessToolIdsForStep` / `readinessToolIdsForSkill`. Tools internas de plataforma/dominio **no** cuentan para el bloqueo. |
| **Estilo deshabilitado** | N3: violeta atenuado; N4: índigo atenuado — [`readiness-test-ui.ts`](../../apps/web/src/lib/operational-cases/readiness-test-ui.ts) |
| **Autoría** | Planificar N1 de integración/acción del paso antes de N3/N4; no exigir N1 de `operational_case_update_state` ni `operational_case_persist_*` |
| **Pills paso/habilidad** | El pill de la **habilidad** refleja el último `skill_test_completed` (N3). El pill del **paso** con escenarios registrados exige todos los escenarios exitosos para **Paso probado**; si sólo pasó la habilidad muestra **Falta probar escenarios del paso**. Una tool puede estar **Probada** (N1) y el paso aún sin cerrar escenarios. |

### `PATTERN_STEP_TEST_BUSINESS_DECISION`

| | |
|--|--|
| **Capa** | `test_contract` + `test_ui` |
| **Cuándo usar** | N4 que cierra un HITL interno ya notificado (precio, contrato, etc.) sin invocar la habilidad raíz |
| **Metadatos** | En `step-test-scenario-registry.ts`: `execution: "business_decision"`, `business_decision_kind`, `decision_text`, semilla y expectativa; handler registrado en `business-decisions/registry.ts` |
| **Ejecución** | `runBusinessDecisionStepTest` — fixture de notificación + `handler.handle` (Telegram/inbox comparten código) |
| **UI** | `resolveStepTestUiCopy` / `formatStepTestResultMetaLine` en [`step-test-ui-copy.ts`](../../apps/web/src/lib/operational-cases/step-test-ui-copy.ts); overrides opcionales `ui.success_summary` por escenario |
| **Autoría** | Preferir este patrón antes del Paso 5 para nuevos HITL; no ramificar copy por `scenario_id` |

### `PATTERN_STEP_STATUS_N3_VS_N4`

| | |
|--|--|
| **Capa** | `test_ui` |
| **Cuándo usar** | Todo paso con escenarios en `step-test-scenario-registry.ts` |
| **Comportamiento** | **Paso probado** (`tested_ok`) sólo cuando **todos** los escenarios *milestone* del registry tienen run exitoso por `scenario_id` (los opcionales/guardrails no cuentan para el hito). Progreso parcial: `partially_tested` + `step_test_progress` («2/4 escenarios del hito probados»; opcionales aparte en checklist). Habilidad probada y escenarios pendientes: `awaiting_n4` (UI: **Falta probar escenarios del paso**). Sin escenarios N4: basta habilidad + integraciones probadas. Copy sin jerga N3/N4 en pills. |
| **Evidencia** | Fuente primaria: `operational_case_test_runs` (`level=n4`, `step_key`, `scenario_id`, `result_jsonb.status`). Fallback legacy: eventos `step_test_completed` sin `scenario_id` sólo cuentan como progreso parcial si hay 2+ escenarios. |
| **Implementación** | [`step-test-scenario-evidence.ts`](../../apps/web/src/lib/operational-cases/step-test-scenario-evidence.ts), [`route.ts`](../../apps/web/src/app/api/tool-readiness/route.ts), [`readiness-test-ui.ts`](../../apps/web/src/lib/operational-cases/readiness-test-ui.ts) |
| **Autoría** | Al crear un case type: registrar todos los escenarios N4 por `step_key`; no asumir que un solo escenario ni N3 cierra el hito en UI ni en checklist de activación. |

### `PATTERN_TOOL_SURFACE_CLASSIFICATION`

| | |
|--|--|
| **Capa** | `runtime` + `test_ui` |
| **Cuándo usar** | Al declarar tools en flow, skills y `allowed_tools` |
| **Comportamiento** | `business_integration` / `external_action` / `internal_notification` / `infrastructure` → tarjeta «Probar tool». `internal_platform` / `internal_domain` → bloque «Herramientas internas» en el hito (sin «Probar tool»; se validan con «Probar habilidad» / «Probar paso»). `scenario_only` → alta/intake, no bloquea pasos operativos. |
| **UI laboratorio** | `ReadinessTestSection`: pill + CTA en el mismo bloque colapsable; gating visual en [`readiness-step-section-ui.ts`](../../apps/web/src/lib/operational-cases/readiness-step-section-ui.ts) (sin duplicar reglas de `tool-readiness/route.ts`). |
| **Implementación** | [`tool-surface-classification.ts`](../../apps/web/src/lib/operational-cases/tool-surface-classification.ts); API `GET /api/tool-readiness`, `run-skill`, `run-step` |

### `PATTERN_CASE_INTAKE_PRECONDITION`

| | |
|--|--|
| **Capa** | `test_runtime` + `test_ui` |
| **Cuándo usar** | Pasos `intake` o equivalentes de preparación antes del primer hito operativo (`awaiting_documents`, etc.) |
| **Comportamiento** | Resumen superior con chips solo sobre tools *readiness-visible* (config OK, sin probar N1, etc.). Tarjeta **Preparar caso de prueba** (N0, pill de fixture) abierta por defecto si falta fixture o sigue en `intake`. Hito `intake` (**Completar registro del caso**) y pasos operativos como **Paso N** en `<details>` cerrados por defecto (hint `N habilidades · M tools` en el summary). Validación de registro vía `safe_check`, no N4. |
| **Implementación** | `partitionFlowSteps`, `INTAKE_PREPARATION_STEP_KEYS`; `fixturePreparationStatus`, `toolReadinessCounts` en `operational-case-types-client.tsx` |

### `PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT`

| | |
|--|--|
| **Capa** | `runtime` + `test_runtime` |
| **Cuándo usar** | Búsquedas de comparables (N1 recipes, N3/N4 semillas, skill `perform-comparable-analysis`) cuando el caso de prueba trae `property_zone` en raíz de `context_jsonb` distinto de `property_data.address.neighborhood` |
| **Comportamiento** | `resolveEffectiveSearchZone` prioriza zona del intake/caso; `mergeContextForToolRecipes` alinea contexto plano para N1; `settingsTestPropertyDataSeed` / `mergePropertyDataForComparables` alinean `property_data` para skills |
| **Implementación** | [`property-search-zone.ts`](../../apps/web/src/lib/operational-cases/property-search-zone.ts); usado en `run-tool`, `run-skill`, `run-step` |
| **Autoría** | Al sembrar property_data en pruebas, no hardcodear otra colonia que la del preset N0 |

### `PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE`

| | |
|--|--|
| **Capa** | `runtime` + `test_runtime` |
| **Cuándo usar** | Cualquier hito que persista `comparables_analysis` y condicione avance a precio |
| **Regla de negocio** | Si `usable_count === 0` sumando **todas** las fuentes (EasyBroker activas, EasyBroker cerradas, BigQuery interno), **no** `price_proposal_pending`; permanecer en `comparables_in_progress` + `waiting_internal` + `notify_user` al asesor con filtros y sugerencias |
| **Implementación** | [`comparables-analysis-validation.ts`](../../apps/web/src/lib/operational-cases/comparables-analysis-validation.ts); validación en `run-skill` (`validateContract`) y `run-step` (`validateStepExpect` en paso `comparables_in_progress`); skill [`perform-comparable-analysis/SKILL.md`](../../skills/global/perform-comparable-analysis/SKILL.md) |
| **Pruebas** | N3 contrato; N4 escenarios `comparables_in_progress_complete` (muestra defendible) e `comparables_in_progress_insufficient_data` (0 usables) |

### `PATTERN_DETERMINISTIC_ARTIFACT_FROM_TOOL_RESULTS`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Artefactos críticos que agregan resultados de tools (`comparables_analysis`, pricing, extracción documental) y gobiernan transiciones |
| **Regla** | El LLM ejecuta tools y decide copy/criterios, pero el artefacto persistido se construye en código desde `tool_calls.result_json`; no desde narrativa ni JSON escrito a mano |
| **Implementación inicial** | `operational_case_persist_comparables_analysis` + [`comparables-analysis.ts`](../../packages/agent/src/operational-cases/comparables-analysis.ts) |
| **Beneficio** | Evita divergencias “tools encontraron datos / narrativa dice éxito / `context_jsonb` quedó vacío o inconsistente” |

### `PATTERN_OPERATIONAL_WRITE_GATE`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | `operational_case_update_state` o cualquier escritura que cambie `current_step`/`status` con precondiciones de negocio |
| **Regla** | El adapter de escritura valida el artefacto y la transición antes de tocar BD; si falla, la tool falla con `hint` accionable |
| **Implementación inicial** | `operational_case_update_state` rechaza `comparables_analysis` sin `stats/data_quality` y bloquea `price_proposal_pending` desde `comparables_in_progress` sin muestra defendible |
| **Autoría** | Las skills deben llamar tools de persistencia dedicadas antes de avanzar pasos críticos |

### `PATTERN_TOOL_AUDIT_SINGLE_OWNER`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Tools de riesgo medio con `auto_execute` en pruebas N3/N4 (p. ej. `generate_document_from_template`, `notify_user`) donde el **handler** ya persiste `tool_calls` con estado final (`executed`, `deduplicated`, `failed`) |
| **Problema que evita** | El grafo creaba una fila previa `approved` y el adapter otra `executed` → auditoría duplicada en UI («2 renders») |
| **Regla** | Si `toolOwnsAuditTrail(toolId)` es verdadero, el nodo de tools del grafo **no** llama a `createToolCall` antes de `invoke()`; solo el handler registra el resultado |
| **Implementación** | [`packages/agent/src/tools/tool-audit-ownership.ts`](../../packages/agent/src/tools/tool-audit-ownership.ts), [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) (rama `auto_execute`) |
| **Autoría** | Al añadir una tool que escribe su propia auditoría, mantenerla fuera de `TOOLS_WITHOUT_INTERNAL_AUDIT` o documentar excepción explícita |

### `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS`

| | |
|--|--|
| **Capa** | `runtime` + `test_contract` |
| **Cuándo usar** | Cualquier paso que llame `generate_document_from_template`, persista el DOCX en Storage y comparta un enlace de descarga al asesor (contrato, ficha, etc.) |
| **Problema que evita** | `signed_url` de Supabase caduca (~1 h), URLs largas en Telegram/notify, y borradores “de mentira” en pruebas sin `output_path` |
| **Implementación genérica** | [`generated-case-document.ts`](../../apps/web/src/lib/operational-cases/generated-case-document.ts): `GeneratedCaseDocumentBinding` (`contextKey`, `documentKey`, `defaultDownloadLabel`, evento opcional) |
| **Sync post-turno** | `syncGeneratedDocumentFromToolCalls(db, case, toolCalls, binding)` — tras agente/cron |
| **Descarga estable** | `GET /api/operational-cases/{caseId}/documents/{documentKey}/download` (proxy autenticado; lee `context[contextKey].output_path`) |
| **Notify** | `generatedCaseDocumentBindingForNotifyKind(kind)` + `normalizeNotifyTextReplacingSignedUrls` en [`notify/index.ts`](../../apps/web/src/lib/notify/index.ts) |
| **Ejemplo binding** | `CONTRACT_DRAFT_DOCUMENT_BINDING` → wrapper [`contract-draft-document.ts`](../../apps/web/src/lib/operational-cases/contract-draft-document.ts); alias legacy `/contract-draft/download` → redirect |
| **Nuevo caso de uso** | 1) Añadir binding al registro `GENERATED_CASE_DOCUMENT_BINDINGS`. 2) Registrar `kind` de notify si aplica. 3) Escenarios N4 Salida A (render + output_path) / Salida B (plantilla faltante). 4) Reutilizar dedup `PATTERN_GENERATED_DOCUMENT_DEDUP` |

### `PATTERN_GENERATED_DOCUMENT_DEDUP`

| | |
|--|--|
| **Capa** | `runtime` |
| **Cuándo usar** | Mismo turno del modelo invoca `generate_document_from_template` dos veces (misma plantilla/formato/caso) |
| **Comportamiento** | Clave `template_slug|format|case_id` con fallback a `ctx.caseId` si el modelo omite `case_id`; mapa en vuelo en el adapter: la primera renderiza, las siguientes devuelven `skipped_render` **sin** segunda fila de auditoría |
| **Complemento grafo** | Colapso de `tool_calls` duplicados en un mismo `AIMessage` vía `idempotentSameMessageDedupKey` |
| **Implementación** | [`packages/types/src/generated-document-dedup.ts`](../../packages/types/src/generated-document-dedup.ts), [`packages/agent/src/tools/realestate-adapters.ts`](../../packages/agent/src/tools/realestate-adapters.ts), [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) |
| **Producción** | Sí — evita doble DOCX y costo en ticks reales |

### `PATTERN_BUSINESS_DECISION_CONTRACT_REVIEW`

| | |
|--|--|
| **Capa** | `runtime` + `test_contract` |
| **Cuándo usar** | Paso `contract_pending`: borrador generado (N3/N4 agente), revisión interna del asesor, envío al dueño y cierre por firma |
| **Flujo producto** | **Tick 1 (skill):** `generate_document_from_template` + `notify_user(kind=contract_review)` + evento `contract_drafted`; **no** enviar al dueño. **HITL:** `parseContractReviewDecision` → `approve_send` \| `request_changes` \| `approve_send_after_revision`. **Producción:** `telegram_send_message_to_contact` al `chat_id` del dueño si existe. **Prueba:** caso `case_type_settings_test` → `paused` + `controlled_test_status` (no mezclar con operación real) |
| **Handlers** | [`contract-review.ts`](../../apps/web/src/lib/business-decisions/contract-review.ts), [`contract-owner-signed.ts`](../../apps/web/src/lib/business-decisions/contract-owner-signed.ts), registro en [`registry.ts`](../../apps/web/src/lib/business-decisions/registry.ts) |
| **Canales** | Telegram (botones `contract_approve_send` / `contract_request_changes` + texto libre), inbox web [`/api/business-decisions/contract-review`](../../apps/web/src/app/api/business-decisions/contract-review/route.ts) |
| **N4 laboratorio** | `contract_pending_draft_review` (Salida A, borrador real) + `contract_pending_template_missing` (Salida B) + tres escenarios HITL (requieren `output_path` previo) — ver matriz §7 |
| **Enlaces borrador** | `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS` con `CONTRACT_DRAFT_DOCUMENT_BINDING` |
| **Relacionado** | `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS`, `PATTERN_STEP_TEST_BUSINESS_DECISION`, `PATTERN_NOTIFY_USER_CHANNELS`, `PATTERN_TOOL_AUDIT_SINGLE_OWNER`, `PATTERN_GENERATED_DOCUMENT_DEDUP` |

---

## 6. Patrones N2 (escenarios guiados A/B/C)

IDs conceptuales para `testPlan` y futuro `test_pattern` en el flow. Detalle procedural en [`testing-framework.md`](testing-framework.md) §5.

| ID | Tools / skill típicas | Sub-pasos | Nivel |
|----|------------------------|-----------|-------|
| `n2_telegram_abc` | `telegram_send_message_to_contact` + skill de mensajería | A validar, B enviar, C simular respuesta (si existe simulador) | N2 |
| `n2_request_documents` | Paso 2 `request-property-documents` | Telegram A→B, luego `list_documents` N1, `notify_user` N1 | N2 + N1 + N3 |
| `n2_characteristics_telegram_abc` | Paso 3 `extract-property-characteristics` | A/B/C para `characteristics_pending` | N2 |
| `n2_easybroker_ab` | `easybroker_create_listing` → `easybroker_upload_images` | A crear borrador, B subir fotos al `listing_id` | N2 |
| `n1_single` | Consultas, listados, extract puntual | Un botón «Probar tool» | N1 |

**Estado UI:** muchos N2 siguen **hardcodeados** en `operational-case-types-client.tsx` (p. ej. `isEasyBrokerCreateScenario`). El catálogo TS prepara migración a metadata declarativa (anillo 2).

---

## 7. Matriz piloto — `property_optioning` (Pasos 2–3 cerrados en QA)

### Paso 2 — `awaiting_documents`

| Prueba | Escenario / skill | Patrones | Salida esperada |
|--------|-------------------|----------|-----------------|
| N3 | `request-property-documents` | `PATTERN_SKILL_TEST_CONTRACT`, `PATTERN_TELEGRAM_DEDUP`, `PATTERN_SKILL_TEST_PROMPT_GUARDRAILS` | `waiting_external`, `reminder_sent` |
| N4 | `awaiting_documents_outreach` | `PATTERN_STEP_TEST_SCENARIO`, mismos Telegram/notify hints | Igual vía raíz |

**Telegram:** contacto **externo** (`purpose` `initial_request` / `requesting_documents`). **No** confundir con `notify_user`.

### Paso 3 — `documents_received`

| Prueba | Escenario | Patrones | Salida esperada |
|--------|-----------|----------|-----------------|
| N3 | `extract-property-characteristics` (revisión interna) | `PATTERN_SKILL_TEST_CONTRACT`, `PATTERN_NOTIFY_USER_CHANNELS`, `PATTERN_SETTINGS_TEST_SEED_AND_REPAIR`, `PATTERN_SKILL_TEST_PROMPT_GUARDRAILS` | `property_data_review`, `waiting_internal`, `notify_user` |
| N4 | `documents_received_property_data_review` | `PATTERN_STEP_TEST_SCENARIO` | Igual vía raíz |
| N4 | `documents_received_characteristics_pending` | `PATTERN_STEP_TEST_SCENARIO`, `PATTERN_TELEGRAM_DEDUP`, semilla incompleta en `context_patch` | `documents_received`, `waiting_external`, Telegram externo |

**Notify interno:** solo en rama revisión interna (`kind=property_data_review`). **Faltantes:** Telegram externo, sin `notify_user` de revisión.

### Paso 4 — `comparables_in_progress`

| Prueba | Escenario / skill | Patrones | Salida esperada |
|--------|-------------------|----------|-----------------|
| N1 | Cada tool de búsqueda (`easybroker_search_*`, `bigquery_lookup_local_comparables`) | `n1_single` | Lista / datos o `not_configured` documentado |
| N3 | `perform-comparable-analysis` | `PATTERN_SKILL_TEST_CONTRACT`, `PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT`, `PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE`, `PATTERN_SETTINGS_TEST_SEED_AND_REPAIR`, `PATTERN_SKILL_TEST_PROMPT_GUARDRAILS` | Con usables: `price_proposal_pending`; sin usables: `comparables_in_progress` + `waiting_internal` + `notify_user` |
| N4 | `comparables_in_progress_complete` | `PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS`, `PATTERN_STEP_TEST_SCENARIO`, `PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT`, `PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE` | `price_proposal_pending` / `active` si muestra defendible |
| N4 | `comparables_in_progress_insufficient_data` | mismos + semilla ~8 m² | `comparables_in_progress` / `waiting_internal` + `notify_user` si 0 usables en todas las fuentes |

**Sin Telegram externo** en este hito. `notify_user` al asesor es obligatorio cuando no hay muestra defendible; opcional al cerrar con usables.

### Paso 4 — `price_proposal_pending`

| Escenario N4 | Qué valida | Ejecución |
|--------------|------------|-----------|
| `price_proposal_pending_hitl` | Propuesta + `notify_user` + queda en espera | Agente raíz |
| `price_proposal_pending_advisor_approves` | Cierre HITL «Aprobar precio» | `handlePriceApprovalDecision` (mismo que Telegram) |
| `price_proposal_pending_advisor_adjusts` | Ajuste + aprobación en un paso | Idem con texto `AJUSTAR PRECIO salida=…` |

Orden sugerido en laboratorio: **HITL** → (opcional N3 si falta) → **Aprobar** o **Ajustar** → recién entonces Paso 5. El pill **Paso probado** puede salir con cualquiera de los N4 exitosos; para cubrir el flujo completo conviene correr los tres.

### Paso 5 — `contract_pending`

| Escenario N4 | Qué valida | Ejecución |
|--------------|------------|-----------|
| `contract_pending_draft_review` | Borrador + `notify_user` + `contract_drafted`; permanece en revisión interna | Agente raíz → `prepare-commission-contract` |
| `contract_pending_advisor_approves_send` | Aprobación para dueño + `reminder_sent` (envío simulado en prueba) | `handleContractReviewDecision` («mándalo al dueño») |
| `contract_pending_advisor_requests_changes` | `contract_changes_requested` + `waiting_internal` | Idem («necesita cambios…») |
| `contract_pending_owner_signed` | Avance a `photos_scheduled` + `step_completed:contract_signed` | `handleContractOwnerSignedDecision` (simulación N4) |

Orden sugerido en laboratorio: **N3** `prepare-commission-contract` → **N4 borrador** (si no cubierto por N3) → **aprobar envío** o **pedir cambios** → (opcional) **firma simulada**. Patrones: `PATTERN_BUSINESS_DECISION_CONTRACT_REVIEW`, `PATTERN_STEP_TEST_BUSINESS_DECISION`, `PATTERN_TOOL_AUDIT_SINGLE_OWNER`, `PATTERN_GENERATED_DOCUMENT_DEDUP`, `PATTERN_NOTIFY_USER_CHANNELS`.

### Pasos 6–7 (`photos_scheduled` … `package_ready`)

| Prueba | Patrones clave | Pill del paso tras N3 OK |
|--------|----------------|---------------------------|
| N3 por habilidad | `PATTERN_STEP_STATUS_N3_VS_N4`, contratos en `run-skill` | **Paso listo para probar** (no **Paso probado**) |
| N4 | `PATTERN_STEP_TEST_SCENARIO` + semillas en `step-test-seeds.ts` | **Paso probado** tras `step_test_completed` |

---

## 8. Checklist — nuevo tipo de caso operacional

Derivado de [`authoring-playbook.md`](authoring-playbook.md) §7, con columna de patrones.

1. [ ] Resultado de negocio final definido.
2. [ ] Actores (asesor interno, contacto externo, integraciones).
3. [ ] Esperas / deadlines / recordatorios.
4. [ ] Artefactos en `context_jsonb` por paso.
5. [ ] Pasos (`step_key`) con entrada/salida claras.
6. [ ] Habilidad raíz compuesta (`*-coach`) con `includes` de atómicas.
7. [ ] Habilidades atómicas por paso (preferir una por paso si basta).
8. [ ] Tools en `allowed_tools` + riesgo/HITL.
9. [ ] `operational_flow_jsonb` alineado 1:1 con runtime.
10. [ ] Por habilidad: `test_contract` o entrada en `SKILL_TEST_CONTRACTS` → **N3**.
11. [ ] Por paso con escenario N4: registrar en `step-test-scenario-registry.ts` → **N4** (aunque haya una sola habilidad si la raíz orquesta el hito). El pill del paso debe usar `PATTERN_STEP_STATUS_N3_VS_N4`: habilidad probada no marca **Paso probado** si faltan escenarios del paso.
12. [ ] **N1 antes de N3/N4:** todas las tools *readiness-visible* del paso probadas (`PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS`).
13. [ ] Asignar IDs `n2_*` / `PATTERN_*` en inventario (§12 [`testing-framework.md`](testing-framework.md)).
14. [ ] Caso de prueba aislado N0; batería N1 → N3 → N4 según matriz.
15. [ ] Activación solo tras checklist UI sin bloqueos rojos.

---

## 9. Ejemplo `testPlan` para propuesta NL (anillo 3)

Bloque que `skill-authoring` (o un endpoint hermano) debería emitir al proponer un caso como `property_optioning`:

```json
{
  "n0": [
    "Credenciales Telegram y secretos de cuenta",
    "Activos: PDF escritura, fotos, plantillas",
    "Caso de prueba aislado regenerado"
  ],
  "steps": [
    {
      "stepKey": "awaiting_documents",
      "patterns": ["n2_request_documents"],
      "n3Skills": ["request-property-documents"],
      "n4Scenarios": ["awaiting_documents_outreach"]
    },
    {
      "stepKey": "documents_received",
      "patterns": ["n2_characteristics_telegram_abc", "n1_single"],
      "n3Skills": ["extract-property-characteristics"],
      "n4Scenarios": [
        "documents_received_property_data_review",
        "documents_received_characteristics_pending"
      ]
    }
  ],
  "runtimePatterns": [
    "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
    "PATTERN_NOTIFY_USER_CHANNELS",
    "PATTERN_CASE_UPDATE_STATE_OPTIMISTIC_RETRY"
  ],
  "uiPatterns": ["PATTERN_SKILL_TEST_CALL_DETAILS"]
}
```

---

## 10. Evolución del catálogo

| Prioridad | Trabajo |
|-----------|---------|
| P0 | Mantener §7 al cerrar QA Paso 4+ (p. ej. escenario fuentes parciales si hace falta) |
| P1 | Consumir `test-patterns-catalog.ts` desde UI (sustituir flags `isEasyBroker*`) |
| P2 | `test_pattern` en `operational_flow_jsonb` |
| P3 | `skill-authoring` emite `testPlan` con IDs del catálogo |
| P4 | Clasificador caso vs skill en pipeline NL |

---

## 11. Archivos de referencia (índice)

| Pieza | Ubicación |
|-------|-----------|
| Catálogo TS | [`test-patterns-catalog.ts`](../../apps/web/src/lib/operational-cases/test-patterns-catalog.ts) |
| UI detalle N3/N4 | [`skill-test-call-details.tsx`](../../apps/web/src/lib/operational-cases/skill-test-call-details.tsx) |
| Escenarios N4 | [`step-test-scenario-registry.ts`](../../apps/web/src/lib/operational-cases/step-test-scenario-registry.ts) |
| N3 API | [`run-skill/route.ts`](../../apps/web/src/app/api/tool-readiness/run-skill/route.ts) |
| N4 API | [`run-step/route.ts`](../../apps/web/src/app/api/tool-readiness/run-step/route.ts) |
| UI Preparación operativa | [`operational-case-types-client.tsx`](../../apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx) |

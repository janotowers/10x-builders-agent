# Matriz de cobertura de aprendizajes reutilizables

> Estado: v1 — inventario previo al Pattern Composition Kernel (2026-08-08).

## Criterio de cierre

Cada aprendizaje identificado en doctrina, catálogo narrativo, catálogo de
pruebas o runtime debe tener uno de estos destinos:

- `kernel`: patrón canónico que Studio puede seleccionar y validar.
- `existing_reusable`: patrón vigente que conserva su ID e implementación.
- `test_only`: contrato de QA que no modifica artefactos compilados.
- `pilot_specific`: regla del piloto que no debe generalizarse sin evidencia.
- `merged`: conocimiento absorbido por un patrón canónico más amplio.

No se considera cubierto un aprendizaje que solo exista como comentario o
comportamiento accidental de runtime.

## Paquetes base por forma de trabajo

| Aprendizaje | Destino | Estado |
| --- | --- | --- |
| Caso: estado durable, timeline, actores, decisiones, artefactos, esperas, auditoría y N0–N5 | `PATTERN_BASE_CASE_WORKFLOW` | `kernel` |
| Tarea durable: inputs, progreso, retries, resultado, cancelación y retención | `PATTERN_BASE_DURABLE_TASK` | `kernel` |
| Skill: activadores/límites MECE, output contract, tools mínimas y Skill Lab | `PATTERN_BASE_REUSABLE_SKILL` | `kernel` |
| Schedule como overlay: recurrencia, timezone, trabajo subyacente y política unattended | `PATTERN_SCHEDULED_TASK_SAFETY` sobre tarea/caso | `kernel` |

## Aprendizajes de runtime que antes no estaban nominalizados

| Familia | Aprendizaje verificado | Fuente actual | Destino |
| --- | --- | --- | --- |
| Cron | Timezone IANA y próxima ocurrencia calculada | `scheduled-tasks/route.ts` | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Lock/lease atómico para impedir doble claim | `markTaskRunning`, `markCaseProcessing` | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Concurrencia acotada por deployment | `SCHEDULED_TASKS_CONCURRENCY` | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Idempotencia por tick y dedup de efectos externos | cron + dedup Telegram/documentos | `PATTERN_SCHEDULED_TASK_SAFETY` + patrón de canal |
| Cron | Retry corto no debe quedar después de la ocurrencia natural | `computeNextRetryAt` | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Retry budget, auto-pausa y escalado visible | scheduled task retry policy | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Capturas HITL parciales no reprograman `next_action_at` | business decisions / case runner | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Sin auto-aprobación blanket; allowlist de riesgo y pending inbox | `scheduled-task-tool-policy.ts` | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Misfire/catch-up debe declararse, no inferirse | gap de autoría | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Cron | Run record, próxima ejecución, cancelación y fallo visibles | scheduled task runs/UI | `PATTERN_SCHEDULED_TASK_SAFETY` |
| Canal | Markdown del agente no se envía literal a Telegram | `agentMarkdownToTelegramHtml` | `PATTERN_CHANNEL_COPY_RENDERING` |
| Canal | Escapado HTML + fallback a plain text | `sendTelegramProductMessage` | `PATTERN_CHANNEL_COPY_RENDERING` |
| Canal | Copy/énfasis se adapta por tipo y canal | notify + renderers | `PATTERN_CHANNEL_COPY_RENDERING` |
| Canal | Límites 4096/1024 y split/truncado seguro | Telegram send + HITL delivery | `PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY` |
| Canal | Documento, caption y botones requieren delivery plan | `hitl-telegram-attachment-delivery.ts` | `PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY` |
| Canal | 429/5xx requieren backoff acotado | Telegram send | `PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY` |
| Canal | Doble tool call no debe duplicar mensaje externo | telegram dedup | `PATTERN_TELEGRAM_DEDUP_SAME_TURN` |
| Respuesta externa | Conversación/contacto deben vincularse al caso correcto | `conversation-case-identity.ts` | `PATTERN_EXTERNAL_RESPONSE_CORRELATION` |
| Respuesta externa | Ambigüedad no muta estado; escala a revisión | guards/router | `PATTERN_EXTERNAL_RESPONSE_CORRELATION` |
| Documentos | Tipo/tamaño, malware, procedencia, hash y retención | intake/upload/storage | `PATTERN_DOCUMENT_INTAKE_REVIEW` |
| Documentos | Extracción, comentario, reemplazo y reanudación del mismo pendiente | attachment envelope/case collection | `PATTERN_DOCUMENT_INTAKE_REVIEW` |
| Artefactos | Inputs/version/hash y staleness | impact plane | `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS` |
| Artefactos | No compartir signed URL efímera en mensajes | generated document proxy | `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS` |
| Email | Preview de destinatario/asunto/cuerpo/adjuntos/fuentes | contract review | `PATTERN_EMAIL_SEND_WITH_APPROVAL` |
| Email | Aprobación fijada a evidencia; un cambio la invalida | approvals/impact plane | `PATTERN_EMAIL_SEND_WITH_APPROVAL` |
| Integración | Readiness, reconexión y retry se distinguen de fallback manual | provider readiness | `PATTERN_INTEGRATION_RECONNECT_DEGRADED_CONTINUATION` |
| Integración | Una opción no implementada genera solicitud gobernada, no código runtime | Studio/tool requests | catálogo de capacidades + patrón de integración |

## Taxonomía humana y UI

| Tipo | Componente registrado | Patrones |
| --- | --- | --- |
| Autorización de acción/tool | `DeliveryPreview`, `DecisionCard` | `PATTERN_EMAIL_SEND_WITH_APPROVAL`, `PATTERN_OPERATIONAL_WRITE_GATE` |
| Decisión de negocio | `DecisionCard` | `PATTERN_HITL_ACTION_CONTRACT` y decisiones registradas |
| Contribución/tarea humana | `FileContribution`, `ArtifactPreview` | `PATTERN_DOCUMENT_INTAKE_REVIEW` |
| Revisión de excepción | `ExceptionPanel` | cron, correlación, integración y remediación |

Web y Telegram son adaptadores del mismo contrato; no se duplican decisiones
de negocio ni acciones por canal.

## Catálogo narrativo y machine-readable existente

### Promovidos o enlazados al kernel

- `PATTERN_TELEGRAM_DEDUP_SAME_TURN` — `kernel`.
- `PATTERN_HITL_ACTION_CONTRACT` — `kernel`.
- `PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER` — `kernel`.
- `PATTERN_SKILL_TEST_CONTRACT` — `kernel` para el paquete de skill.
- `PATTERN_INTEGRATION_RECONNECT_DEGRADED_CONTINUATION` — `kernel`.
- `PATTERN_OPERATIONAL_WRITE_GATE` — `kernel`.
- `PATTERN_TOOL_AUDIT_SINGLE_OWNER` — `kernel`.
- `PATTERN_GENERATED_CASE_DOCUMENT_ACCESS` — `kernel`.

### Reutilizables existentes; seleccionados solo cuando su semántica aplica

- `PATTERN_NOTIFY_USER_CHANNELS`
- `PATTERN_CASE_UPDATE_STATE_OPTIMISTIC_RETRY`
- `PATTERN_ARTIFACT_IDENTITY_STALENESS`
- `PATTERN_GATED_TRANSITION_WITH_OWNED_REMEDIATION`
- `PATTERN_SKILL_GATE_CONTRACT_PARITY`
- `PATTERN_STEP_BRANCH_DECISION`
- `PATTERN_NOTIFY_DELIVERY_WARNING`
- `PATTERN_CASE_INTAKE_PRECONDITION`
- `PATTERN_DETERMINISTIC_ARTIFACT_FROM_TOOL_RESULTS`
- `PATTERN_GENERATED_DOCUMENT_DEDUP`
- `PATTERN_BUSINESS_DECISION_CONTRACT_REVIEW`
- `PATTERN_BUSINESS_DECISION_CONTRACT_DATA_REVIEW`

Estos IDs se conservan. El kernel puede depender de ellos cuando el trigger lo
requiera; no se renombran ni se copian como pseudo-código.

### Contratos de prueba

- `PATTERN_SETTINGS_TEST_SEED_AND_REPAIR`
- `PATTERN_SKILL_TEST_CONTRACT`
- `PATTERN_STEP_TEST_SCENARIO`
- `PATTERN_STEP_TEST_BUSINESS_DECISION`
- `PATTERN_SKILL_TEST_PROMPT_GUARDRAILS`
- `PATTERN_SKILL_TEST_CALL_DETAILS`
- `PATTERN_READINESS_N3_N4_BLOCKED_BY_TOOLS`
- `PATTERN_STEP_STATUS_N3_VS_N4`
- `PATTERN_TOOL_SURFACE_CLASSIFICATION`

Destino: `test_only`. Alimentan `testContract` y los gates N0–N5, pero no
inyectan reglas de negocio en producción.

Escenarios guiados existentes, también `test_only`:

- `n2_telegram_abc`
- `n2_request_documents`
- `n2_characteristics_telegram_abc`
- `n2_easybroker_ab`
- `n1_single`

### Específicos del piloto inmobiliario

- `PATTERN_LAB_FORM_PROPERTY_DATA_SYNC`
- `PATTERN_COMPARABLE_SEARCH_ZONE_ALIGNMENT`
- `PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE`

Destino: `pilot_specific`. Se pueden componer para `property_optioning`, pero
no se convierten en defaults de toda forma de trabajo.

## Patrones canónicos nuevos

- `PATTERN_BASE_CASE_WORKFLOW`
- `PATTERN_BASE_DURABLE_TASK`
- `PATTERN_BASE_REUSABLE_SKILL`
- `PATTERN_SCHEDULED_TASK_SAFETY`
- `PATTERN_CHANNEL_COPY_RENDERING`
- `PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY`
- `PATTERN_EXTERNAL_RESPONSE_CORRELATION`
- `PATTERN_DOCUMENT_INTAKE_REVIEW`
- `PATTERN_EMAIL_SEND_WITH_APPROVAL`

## Invariantes automatizables

1. IDs y versiones únicos.
2. Dependencias existentes y sin ciclos.
3. Incompatibilidades simétricas.
4. Forma de trabajo, triggers, taxonomía humana y componentes dentro de enums.
5. Todo patrón activo tiene directivas, reglas de validación, pruebas y evidencia.
6. Todo paquete base resuelve a una composición válida.
7. Todo trigger de efecto externo selecciona gate, auditoría y prueba.
8. Ningún provider `candidate` se presenta como conectado o recomendado sin
   verificación y readiness.

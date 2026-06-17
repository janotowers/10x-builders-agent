# Subsistema de Casos operacionales — Arquitectura

> Este documento sobrevive al plan. Describe **cómo funciona** el subsistema una vez implementado, separado del plan de ejecución y de las decisiones temporales.
>
> Plan asociado: [`plan.md`](plan.md). Consideraciones futuras: [`future-considerations.md`](future-considerations.md).
> Marco de pruebas: [`testing-framework.md`](testing-framework.md) (N0–N5). **Playbook de autoría:** [`authoring-playbook.md`](authoring-playbook.md). Visión de autoría NL: [`use-case-authoring-vision.md`](use-case-authoring-vision.md).

---

## 1. Por qué existe

El runtime actual de Gu OS (LangGraph + skills + tools + HITL + Heartbeat + scheduled tasks) cubre bien:

- conversaciones turn-by-turn,
- pausas cortas con HITL dentro de un turno,
- pulsos periódicos exception-first,
- tareas programadas one-shot/recurrentes con prompts.

No cubre bien procedimientos operativos **multi-día** que combinan: pasos secuenciales, esperas a humanos externos (dueño que no responde), recordatorios escalonados, deadlines, eventos asíncronos entrantes, reanudación, y memoria de "dónde voy" separada del thread de chat.

Ese es el hueco que llena el subsistema de casos operacionales.

---

## 2. Modelo conceptual

```mermaid
flowchart TB
  subgraph Definicion
    TYPE["operational_case_types<br/>case_type, default_skill,<br/>default_reminder_policy"]
  end

  subgraph Instancias
    CASE["operational_cases<br/>id, user_id, case_type,<br/>status, current_step,<br/>next_action_at, due_at,<br/>context_jsonb, version"]
    EVT["operational_case_events<br/>append-only timeline"]
  end

  subgraph Procesamiento
    CRON["Cron operational-cases"]
    AGT["runAgent canal case_runner"]
    SKL["Skill activa = type.default_skill_slug"]
    NOT["notify(user_id, payload, urgency)"]
  end

  TYPE -.define.-> CASE
  CASE -- "next_action_at <= now()" --> CRON
  CRON -- "lock + invocar" --> AGT
  AGT -- "binding directo" --> SKL
  SKL -- "decide y actua" --> AGT
  AGT -- "registra eventos" --> EVT
  AGT -- "actualiza estado" --> CASE
  AGT -- "comunica al humano interno" --> NOT
```

- **Tipo de caso (`operational_case_types`)** define el "qué procedimiento es" (`property_optioning`, `lead_qualification`, etc.) y a qué skill compuesta apunta por default.
- **Instancia (`operational_cases`)** es la unidad viva. Tiene estado, paso actual, deadline, contexto y versión para optimistic locking.
- **Eventos (`operational_case_events`)** son la historia append-only. Reconstrucción completa siempre disponible.

### 2.1 Paso del flujo, habilidad raíz y `current_step`

Detalle completo, ejemplos y criterios de autoría: [`authoring-playbook.md`](authoring-playbook.md).

| Concepto | Dónde | Rol |
|----------|--------|-----|
| **Habilidad raíz** (compuesta) | `operational_case_types.default_skill_slug` | Única habilidad que el cron invoca por `case_type` (p. ej. `property-optioning-coach`). |
| **Paso del flujo** | `operational_flow_jsonb[]` con `step_key` | Hito de negocio para UI, readiness y pruebas; `step_key` = valores posibles de `current_step`. |
| **Habilidades del paso** | `step_skills[]` (atómicas, 0..n) | Catálogo de comportamientos del hito; la raíz elige cuál aplicar según estado — **no** es cola automática del array. |
| **`current_step`** | `operational_cases` | Puntero al hito (`step_key`), no al slug de una habilidad. |
| **`status`** | `operational_cases` | Modo del motor (`active`, `waiting_external`, …). |
| **`context_jsonb`** | `operational_cases` | Sub-progreso dentro del hito (flags, artefactos parciales). |

`operational_flow_jsonb` documenta y prueba; **no** sustituye la orquestación en el `SKILL.md` de la habilidad raíz.

---

## 3. Ciclo de vida de un caso

```mermaid
stateDiagram-v2
  [*] --> active: usuario abre caso
  active --> waiting_external: agente pide algo a humano externo
  active --> waiting_internal: agente pide aprobacion/input del asesor interno
  waiting_external --> active: respuesta entrante via webhook
  waiting_external --> active: timer vence + recordatorio enviado
  waiting_internal --> active: asesor aprueba o ajusta y aprueba
  waiting_internal --> active: timer vence + recordatorio interno
  active --> paused: humano interno pausa
  paused --> active: humano interno reanuda
  active --> completed: ultimo paso completado
  active --> failed: error fatal o timeout duro
  waiting_external --> failed: timeout duro sin respuesta
```

Estados:

| Estado | Significado |
|---|---|
| `active` | El sistema (cron) procesará en `next_action_at`. |
| `waiting_external` | Esperando input externo (dueño, lead). El cron solo dispara recordatorios/escalación según `due_at` y reminder policy. |
| `waiting_internal` | Esperando input o aprobación del asesor/inmobiliario (ej. aprobación de precio). El cron puede enviar recordatorios internos; la decisión llega por web (Pendientes) o Telegram. |
| `paused` | El humano interno lo detuvo a propósito; el cron lo ignora. |
| `completed` | Todos los pasos completos. El caso es solo lectura/auditoría. |
| `failed` | Error fatal o se excedió un timeout duro sin recuperación posible. |

---

## 4. Procesamiento (cron + agente)

```mermaid
sequenceDiagram
  participant Cron
  participant DB
  participant Agent
  participant Skill
  participant Tools

  Cron->>DB: select for update skip locked<br/>where status in (active, waiting_internal, waiting_external)<br/>and next_action_at <= now()
  DB-->>Cron: lote de casos
  loop por cada caso
    Cron->>Cron: re-leer fuente (mensajes recientes)
    alt Hay actualizacion no procesada
      Cron->>DB: actualizar caso + insertar evento
    end
    Cron->>Agent: runAgent({ caseId, channel: case_runner })
    Agent->>DB: leer caso + ultimos N eventos
    Agent->>Skill: binding directo a default_skill_slug
    Skill->>Tools: ejecutar tools acotadas
    Tools-->>Skill: resultados
    Skill-->>Agent: decision + actualizacion de estado
    Agent->>DB: insertar eventos + actualizar caso (version+1)
    Agent->>DB: liberar lock
  end
```

**Reglas duras del cron:**

- El cron es **determinístico**. No usa LLM. Solo decide "este caso vence" e invoca `runAgent` con `caseId`.
- El cron **siempre re-lee la fuente** antes de actuar para evitar recordatorios molestos sobre estado obsoleto.
- El cron toma **lock por caso** con `select ... for update skip locked`; nunca dos workers procesan el mismo caso a la vez.

**Reglas duras del agente (cuando se invoca con `caseId`):**

- Lee `operational_cases` + últimos N eventos antes de razonar.
- **Binding directo de skill**: salta el selector. La skill es `operational_case_types.default_skill_slug`.
- Cualquier escritura al caso usa `version` para optimistic locking; si choca, reintenta.
- Decisiones de juicio comercial (precio, contrato, publicación) **siempre HITL**.

### Detalle: límite de lote, cola en memoria y concurrencia (implementación actual)

La ruta `POST /api/cron/operational-cases` no procesa “solo los primeros N casos y descarta el resto”. Comportamiento real:

| Pieza | Comportamiento |
|---|---|
| **Lectura desde Postgres** | `getDueOperationalCases` trae un **lote acotado** de filas vencidas. El caller del cron pasa `limit` (p. ej. 100). La query en `packages/db` **caps** el valor a **máximo 200** por invocación. Si hay más casos vencidos que ese límite, el **sobrante sigue en base** con `next_action_at` en el pasado y se atenderá en **la siguiente ejecución** del cron (o en la misma si el primer lote ya avanzó y vació cola). |
| **Cola en esta invocación** | Todos los casos devueltos en ese lote entran en una **cola en memoria**. Varios **workers** (ver abajo) van sacando de la cola de uno en uno; **cada worker espera** a que termine `processCase` antes de tomar el siguiente. |
| **`OPERATIONAL_CASES_CONCURRENCY`** | Número de workers **en paralelo dentro de una misma** invocación HTTP del cron. Es **global** a esa corrida (no “por usuario”). El valor se **acota entre 1 y 20** en código. No aumenta cuántos casos se **leen** de Postgres; solo cuántos `runAgent` corren a la vez sobre el lote ya cargado. |
| **Lock por caso** | `markCaseProcessing` implementa un lease corto vía `version` + `next_action_at`. Si dos invocaciones del cron se solapan, un caso puede devolver `skipped` para la segunda; **no se pierde**: volverá a salir como vencido en otro tick. |

**Aclaración importante:** el límite de concurrencia **no** significa que los casos 6–50 “no se atienden” en esa corrida: se atienden **después** en la misma petición, en serie por worker, en orden de salida de la cola. Lo que **sí** puede quedar fuera es lo que **no entró en el lote** por el `limit` de la query (p. ej. >100 si el cron pide 100).

### Señales de degradación y cómo escalar con criterio

Cuando el volumen suba, vigilar:

| Señal | Qué suele indicar |
|---|---|
| **Cola de vencidos que no baja** (muchas filas con `next_action_at <= now()` por varios ticks) | El cron no alcanza a drenar: duración de cada `runAgent` muy alta, lote muy pequeño, o frecuencia del cron baja. |
| **Duración del request del cron** cerca del timeout del hosting | Demasiados casos por invocación o pasos demasiado pesados; riesgo de cortes a medias. |
| **Aumento de `skipped`** en logs | Solapamiento de schedulers o contención de `version`; revisar que no haya dos crons pegándole al mismo endpoint con la misma ventana. |
| **402 / rate limit** del proveedor LLM | Demasiada concurrencia o demasiados casos activos a la vez. |
| **Presión en pool de Postgres** | Muchas sesiones concurrentes de agente escribiendo en el mismo proyecto. |

**Palancas típicas (en orden de “menos riesgo” a “más invasivo”):**

1. **Aumentar la frecuencia del cron** (p. ej. cada 1–2 min en lugar de 5) para drenar el mismo límite de filas más veces por hora.
2. **Subir el `limit` del lote** en la llamada a `getDueOperationalCases` (respetando cap 200 en DB o subiendo ese cap de forma consciente) si el código y el timeout lo permiten.
3. **Subir `OPERATIONAL_CASES_CONCURRENCY` dentro del rango 1–20** solo si hay margen de costo LLM, límites de API y CPU/memoria del despliegue.
4. **Aligerar el trabajo por tick**: skills más cortas, menos tools por paso, o pasos que no invoquen al LLM cuando se pueda hacer con SQL determinista.
5. **Observabilidad**: métricas de “casos vencidos pendientes”, latencia p95 del cron, y ratio ok/skipped/error por tick.

Cuando ni con frecuencia + lote + concurrencia razonable se estabiliza la cola, **volver a leer** la sección de motor durable en [`future-considerations.md`](future-considerations.md) (Temporal/Inngest): no es el primer remedio, pero es el camino cuando el patrón cron+lote deja de ser mantenible.

---

## 5. Concurrencia con turnos del usuario

Los casos no compiten con turnos web/Telegram del usuario. Cada `runAgent` es invocación independiente con su propio thread:

```mermaid
flowchart TB
  subgraph Procesos
    UW["Usuario web<br/>runAgent invocacion A"]
    CR["Cron caso<br/>runAgent invocacion B"]
    HB["Heartbeat<br/>runAgent invocacion C"]
  end
  PG[("Postgres<br/>profiles, sessions, tool_calls,<br/>operational_cases, events")]
  UW --> PG
  CR --> PG
  HB --> PG
```

- Si el usuario pregunta sobre un caso mientras el cron lo procesa, el `runAgent` del usuario lee el caso (lectura no bloquea), pero al escribir respeta el lock; si el caso está bloqueado, responde con la última versión visible y avisa "se está procesando".
- Costos LLM acotados con concurrencia limitada en cada cron (`OPERATIONAL_CASES_CONCURRENCY` similar a `HEARTBEAT_CONCURRENCY`).

---

## 6. Webhook de eventos externos

Una respuesta entrante de un humano externo (ej. el dueño manda foto del predial por Telegram) debe poder despertar el caso inmediatamente, sin esperar el siguiente tick del cron.

Patrón:

1. El webhook del canal (`/api/telegram/webhook`) detecta que el mensaje viene de un `chat_id` asociado a un caso `waiting_external`.
2. Inserta un evento `external_response` en `operational_case_events`.
3. Actualiza `operational_cases.next_action_at = now()` para que el siguiente tick del cron lo procese.
4. Opcional: dispara procesamiento inmediato si la concurrencia lo permite.

Esta asociación se mantiene en `operational_cases.external_contact_jsonb` (`{ channel, chat_id }`).

---

## 6.1 Routing conversacional durable (usuario interno)

Además de respuestas de contactos externos, el sistema soporta conversaciones
multi-turn del usuario interno (inmobiliario/asesor) que pueden iniciar o
continuar casos operacionales. Este routing no debe depender sólo del último
mensaje ni de regex de intención: usa un binding durable entre canal y caso.

Tabla:

| Tabla | Rol |
|---|---|
| `operational_case_conversation_bindings` | Vínculo entre `user_id`, canal/chat/sesión y `case_id` mientras un caso espera input conversacional (`awaiting_user`) o una aclaración (`clarification_needed`). |

Estados del binding:

| Estado | Significado |
|---|---|
| `awaiting_user` | El caso puede recibir una respuesta futura del usuario por ese canal. |
| `clarification_needed` | Llegó un mensaje ambiguo; el sistema preguntó a qué caso/flujo corresponde. |
| `resolved` | El binding cumplió su propósito y ya no enruta mensajes. |
| `expired` | El binding venció por política de tiempo. |
| `cancelled` | El usuario o sistema lo canceló explícitamente. |

Flujo de routing:

```mermaid
flowchart TD
  inboundMessage["Mensaje del usuario"] --> explicitHandlers["Comandos, callbacks, decisiones HITL"]
  explicitHandlers --> bindings["Buscar bindings pendientes por user/channel/chat"]
  bindings --> resolver["Resolver candidatos y confianza"]
  resolver --> caseRoute["Alta confianza: runAgent con caseId"]
  resolver --> generalRoute["Baja confianza: runAgent general"]
  resolver --> clarifyRoute["Ambiguo: pedir aclaración"]
  clarifyRoute --> pendingClarification["Guardar mensaje original y candidatos"]
  pendingClarification --> userChoice["Usuario confirma"]
  userChoice --> caseRoute
```

Reglas:

- Un binding pendiente **no significa** que todo mensaje siguiente pertenece al
  caso. Sólo declara que existe un candidato activo.
- Mensajes claramente no relacionados (analytics, agenda, preguntas generales,
  etc.) se responden como conversación general y **no cierran** el binding.
- Mensajes ambiguos deben pedir aclaración con:
  - tipo de caso (`case_type` / display name),
  - resumen humano del caso,
  - estado técnico (`status / current_step`),
  - ID corto del caso.
- No crear casos nuevos por keywords inmobiliarios si no hay intención clara o
  aclaración positiva.
- `paused` significa pausa deliberada; no representa intake pendiente. La espera
  conversacional se modela con el binding `awaiting_user`.

Este patrón es canal-agnóstico. Telegram usa `channel='telegram'` + `chat_id`;
web chat puede usar `channel='web'` + `session_id`. Para canales futuros
(WhatsApp, email), extender el check de `channel` en la migración y reutilizar el
mismo resolver.

---

## 7. Notificación al humano interno

Capa `notify(user_id, payload, urgency)` en [`apps/web/src/lib/notify/index.ts`](../../apps/web/src/lib/notify/index.ts):

- Lee `user_notification_preferences.channels_priority_jsonb` (default `["web", "telegram"]`).
- **Siempre** persiste una fila en `internal_user_notifications` (canal web = inbox/action item), independientemente de si el usuario tiene la consola abierta.
- Intenta entrega push por otros canales configurados (hoy: Telegram vía `getTelegramChatId`).
- Urgencia `high` intenta todos los canales habilitados; `normal`/`low` se detiene tras el primer canal exitoso (excepto web, que ya quedó almacenado).

Tablas (migración `00035_persistent_notifications.sql`):

| Tabla | Rol |
|---|---|
| `internal_user_notifications` | Pendientes del asesor: título, cuerpo, `kind`, `status` (`unread` → `read` / `actioned` / `dismissed`), `due_at`, `action_url`, metadata |
| `external_contact_notifications` | Seguimiento de mensajes a contactos externos (Telegram hoy): intentos, `next_reminder_at`, escalación |

API y UI:

- `GET/PATCH/DELETE /api/notifications` — listar pendientes unread, marcar estado y limpiar bandeja (ver scopes abajo).
- Consola web → **Pendientes** (`/chat/pending`): bandeja dedicada con notificaciones internas, tarjetas **HITL** (`tool_calls` en `pending_confirmation`), recordatorios agrupados, vencimiento/escalación y acciones inline cuando aplica (`price_approval`, `contract_review`, `property_data_review`).
- La bandeja hace **auto-sync** mientras la pestaña está visible (30s dev / 60s prod) y al volver a la pestaña; no hay botón manual de refrescar.
- Menú **Opciones** en la bandeja: ver/ocultar atendidos recientes; **Limpiar bandeja** → historial de atendidos o pendientes de laboratorio (casos `case_type_settings_test`).

**Scopes `DELETE /api/notifications`:**

| Scope | Efecto |
|---|---|
| `resolved-history` | Borra notificaciones `read` / `actioned` / `dismissed` del usuario. |
| `settings-test` | Limpia pendientes de casos de laboratorio en Ajustes: notificaciones, rechaza tool calls bloqueantes y cierra recordatorios huérfanos. |
| `stuck-case` (+ `case_id`) | Rechaza tools pendientes del caso y lo pausa (salvaguarda manual). |

Recordatorios (mismo cron `POST /api/cron/operational-cases`):

- Antes de procesar casos vencidos, el cron consulta `internal_user_notifications` con `status = unread` y `due_at <= now()`.
- Reenvía vía `notify()` con `kind = internal_notification_reminder` y respeta cooldown desde `metadata_jsonb.last_reminder_at`.
- Los defaults de cadencia se resuelven en `apps/web/src/lib/engagement-policies/registry.ts` por audiencia, intención, canal, prioridad y `kind`:
  - `internal_user + approval + price_approval`: `due_at` automático **+4h** si el caller no lo envía; cooldown **4h**.
  - `internal_user + approval + tool_confirmation_pending`: recordatorio de que hay acciones HITL sin resolver; cooldown **4h**, máx. **3** intentos, escalación a **24h** con prioridad `high`.
  - `external_contact/prospect/owner + reminder/followup`: cooldown **24h**, max intentos **3** antes de escalar al asesor.
  - `high` priority puede reducir cooldown interno a **1h**.
- **Overrides por cuenta (V1):** `user_notification_preferences.engagement_policy_overrides_jsonb` (`by_audience`, `by_kind`) permite ajustar cooldown, máx. intentos, escalación y **ventana de entrega** (días de la semana + horario local + timezone). UI en **Ajustes → Proactividad → Políticas de entrega** (`/settings?view=proactivity&section=delivery-policies`); API `GET/POST /api/notification-preferences`. Migración `00036_notification_engagement_policy_overrides.sql`.
- **Ventana de entrega:** si `respectWorkingHours` está activo y el envío cae fuera de la ventana configurada, el cron **reprograma** (`due_at` / `next_reminder_at`) al siguiente horario permitido en lugar de descartar el recordatorio. Defaults: asesor interno **08:00–21:00** (lun–dom); contacto externo **09:00–20:00** (lun–sáb). Timezone: `profiles.timezone` del asesor (contactos externos usan el mismo proxy en V1).
- Recordatorios HITL en Telegram reconstruyen botones **Aprobar/Cancelar** desde `pending_tool_call_id`; si el `tool_call` ya no está en `pending_confirmation`, el cron cierra la notificación como obsoleta en lugar de mandar un nudge pasivo.
- **Resolución del pendiente cross-sesión:** el `tool_call` que respalda el aviso HITL se busca en **todas** las sesiones del asesor (`listPendingCaseToolCalls`), no solo en `case_runner`. Una confirmación puede originarse en un chat de Telegram/web; restringir a `case_runner` dejaba `pendingReference = null`, lo que producía un recordatorio anónimo (sin identificar el caso) y sin `pending_tool_call_id` (sin botones). El webhook resuelve `approve:`/`reject:` por el `session_id` del propio `tool_call`, así que los botones funcionan sin importar el canal de origen. Si aun así no se resuelve el `tool_call`, el texto de respaldo identifica el caso por título/zona.
- **Self-heal de recordatorios HITL:** antes de reenviar un `tool_confirmation_pending`, el cron revalida pendientes por `case_id`. Si encuentra `tool_call` vivo pero la notificación estaba degradada (sin `Caso:` o sin `pending_tool_call_id`), refresca `body` y metadata para que recordatorios/escalaciones salgan accionables con contexto y botones en Telegram. Si no queda ningún pendiente (aunque falte `pending_tool_call_id`), marca la notificación como `actioned` para cortar recordatorios huérfanos.
- Tras **atender** un pendiente (PATCH `actioned`/`dismissed` o handler de business decision), los recordatorios ligados al mismo `source_notification_id` se cierran en cascada para evitar avisos huérfanos.
- **Pendiente (futuro):** overrides por `case_type`/canal individual en UI; timezone por contacto externo; defer también en el primer push inmediato de Telegram (hoy aplica principalmente a recordatorios del cron).

### 7.1 HITL de negocio vs HITL de ejecución de tools

Son capas distintas:

| Capa | Cuándo | Mecanismo | Ejemplo |
|---|---|---|---|
| **HITL de tool** | Antes de ejecutar una tool `medium`/`high` | LangGraph `interrupt()` + tarjetas en **Pendientes** y botones Aprobar/Rechazar en web/Telegram | `calendar_create_event`, `telegram_send_message_to_contact` |
| **HITL de negocio** | Después de que el agente preparó una decisión comercial | `notify_user` crea pendiente persistente; el humano decide por UI o texto estructurado | Aprobación de `pricing_proposal` (`kind = price_approval`), revisión de datos (`property_data_review`) |

#### HITL de tool en casos operativos (anti-spam del cron)

Cuando un tick del cron llega a un caso con **tool calls en `pending_confirmation`**, el runtime **no** vuelve a invocar `runAgent` (evita duplicar tarjetas «Aprobación del agente»). En su lugar:

1. Pone `operational_cases.next_action_at = null` hasta que el humano resuelva el HITL.
2. Upsert de notificación `kind = tool_confirmation_pending` vía `notify()` (reutiliza la activa del mismo caso/kind).
3. Los recordatorios de esa notificación siguen la política de engagement (4h / 3 intentos / escalación 24h).

Al **aprobar o rechazar** la tool (`POST /api/chat/confirm` o callback Telegram):

- Se cierran notificaciones `tool_confirmation_pending` del caso.
- Si ya no quedan tools pendientes, se fija `next_action_at = now()` para que el siguiente tick retome el flujo.

En la bandeja web, la tarjeta accionable del `tool_call` prevalece sobre la notificación `tool_confirmation_pending` del mismo caso (deduplicación en UI).

Flujo **price_approval** (implementado):

```mermaid
sequenceDiagram
  participant Skill as prepare-listing-price
  participant Notify as notify_user
  participant Inbox as internal_user_notifications
  participant User as Asesor web/Telegram
  participant API as business-decisions/price-approval
  participant Case as operational_cases

  Skill->>Notify: kind=price_approval, case_id, texto propuesta
  Notify->>Inbox: insert unread + due_at
  Notify->>User: Telegram con botones Aprobar / Ajustar y aprobar
  User->>API: Aprobar o AJUSTAR PRECIO salida=... ideal=... minimo=...
  API->>Case: pricing_proposal approved, step=contract_pending
  API->>Inbox: status=actioned
  API->>Case: event human_decision price_approved o price_adjusted_and_approved
```

Reglas de producto actuales:

- **Aprobar precio**: aprueba la propuesta tal cual y avanza a `contract_pending`.
- **Ajustar y aprobar**: el asesor envía montos concretos; se aplican, se aprueban y avanza (un solo paso, sin segunda confirmación).
- **Rechazar / pedir revisión**: no expuesto en UI/Telegram en este MVP; requiere rama completa (motivo → skill replantea → nueva notificación) antes de activarse.

Handler compartido: [`apps/web/src/lib/business-decisions/price-approval.ts`](../../apps/web/src/lib/business-decisions/price-approval.ts). Telegram enruta callbacks `price_approve:*` / `price_adjust:*` y respuestas textuales parseadas en el webhook.

Flujo **property_data_review** (implementado):

- Skill/coach solicita revisión con `notify_user(kind=property_data_review)`.
- El asesor confirma o corrige desde **Pendientes** (inline) o Telegram (`property_data_confirm` / `property_data_correct`).
- Handler compartido: [`apps/web/src/lib/business-decisions/property-data-review.ts`](../../apps/web/src/lib/business-decisions/property-data-review.ts); API `POST /api/business-decisions/property-data-review`.

---

## 8. Skills compuestas y atómicas

Una skill compuesta (`property-optioning-coach`) usa `includes` para combinar atómicas. Cada atómica es un SKILL.md con `allowed_tools` acotado; la composite hereda la unión.

```mermaid
flowchart TB
  COMP["property-optioning-coach<br/>(composite, scope: business)"]
  A1["request-property-documents"]
  A2["extract-property-characteristics"]
  A3["perform-comparable-analysis"]
  A4["prepare-listing-price"]
  A5["prepare-commission-contract"]
  A6["coordinate-photo-session"]
  A7["publish-listing-package"]

  COMP --> A1
  COMP --> A2
  COMP --> A3
  COMP --> A4
  COMP --> A5
  COMP --> A6
  COMP --> A7
```

Doctrina:

- La composite describe la **secuencia esperada** y los **gates HITL**.
- Las atómicas son reusables fuera del caso (ej. `request-property-documents` puede invocarse standalone).
- Promoción a `account_skills`: cuando una composite es específica de un cliente (ej. variante de Alebrixe), se mueve de `skills/global/` a `account_skills` de ese cliente.

---

## 9. Account skills V1: cómo se integra

El runtime de skills (`packages/agent/src/skills/runtime.ts`) compone el registry así:

```mermaid
flowchart LR
  G["skills/global/*<br/>SKILL.md"]
  A["account_skills<br/>WHERE user_id = ? AND status = active"]
  R["Registry compuesto<br/>account_skills tienen prioridad por slug"]
  G --> R
  A --> R
```

- Si una `account_skill` y una global tienen el mismo slug, **gana la account**. Esto permite que un cliente customice una skill global sin perder la base.
- `includes` puede mezclar orígenes (una composite global puede incluir una atómica de cuenta y viceversa).
- Validación Zod idéntica para ambos orígenes.

---

## 10. Tool readiness y provisioning (credenciales por cuenta)

Antes de activar o probar un **tipo de caso privado** con skill propia, la UI puede
diagnosticar si las tools declaradas en metadata (`allowed_tools` + `includes`)
están listas: catálogo, adapter, integración OAuth/vínculo, y **secretos por
cuenta** cuando aplica.

| Pieza | Rol |
|---|---|
| `GET /api/tool-readiness?case_type_id=…` | Resuelve sólo metadata de skills (no compone el body completo) y devuelve por tool: estado, categoría, si bloquea prueba controlada, acción sugerida y `account_provider` cuando aplica (`easybroker`, `easybroker_web`, `ungga_api`, `ungga`). |
| `account_tool_secrets` | Migración `00024_account_tool_secrets.sql`. Una fila por `(user_id, provider)`: `config_jsonb` público para la UI, secretos cifrados en columna dedicada. Estados `pending_test` → `active` / `invalid` tras `POST …/test`. Providers inmobiliarios: `easybroker` (API key write), `easybroker_web` (email/password MLS), `ungga_api`, `ungga`. |
| `account_assets` | Assets privados por cuenta requeridos por `operational_flow_jsonb.required_assets` o assets temporales de prueba declarados por `asset_profile.test` / `test_assets` (plantillas, watermarks, fotos de prueba, etc.). El archivo vive en Supabase Storage y la tabla guarda metadata/ruta. |
| `GET/PUT/DELETE /api/account-tool-secrets` | CRUD sin exponer secretos en GET; PUT valida contra `apps/web/src/lib/account-tool-providers.ts`. |
| `POST /api/account-tool-secrets/[provider]/test` | Prueba de conexión por provider (API ping o sesión Playwright según provider); actualiza `status` y puede cerrar solicitudes abiertas en `global_tool_requests` para tools cubiertas por ese provider. |
| `global_tool_requests` | Migración `00023_global_tool_requests.sql`. Backlog cuando falta capacidad global o recurso de tenant; `GET/POST /api/global-tool-requests`. |
| `operational-case-tests` + `run-tool` | Casos de prueba por `case_type` con contexto de muestra (`test-context-samples.ts`); `POST …/run-tool` ejecuta una tool con args derivados del caso (opcional `case_id` para no usar siempre el último). |
| UI Casos de uso | **Preparación operativa**: revisar lista, expandir tool, conectar providers inline (mismo form que Ajustes), probar tool con vista previa legible de resultados. **Checks de activación**: checklist alineada con bloqueos de readiness. Marco N0–N5: [`testing-framework.md`](testing-framework.md). Modelo de autoría: [`authoring-playbook.md`](authoring-playbook.md). |
| UI Ajustes | Vista **Integraciones** (`/settings?view=integrations`): tabs **Conexiones** (OAuth/vínculo: Google, GitHub, Telegram), **Canales** y **Credenciales por cuenta** (API keys/tokens/credenciales web cifrados). Vista **Capacidades** (`/settings?view=capabilities`): **Habilidades activadas**, **Herramientas permitidas** y **Solicitudes** (backlog `global_tool_requests`; `/settings/tool-requests` redirige a `section=requests`). |
| POC Playwright | `pocs/easybroker-mls-cli/` y `pocs/ungga-cli/`; instalar browsers con `npm run setup:pocs` en la raíz del monorepo. |

Los adapters en `realestate-adapters.ts` **priorizan** secretos por cuenta y
**caen** a variables de entorno solo para despliegues legacy
(`EASYBROKER_API_KEY`, `UNGGA_INTERNAL_API_*`). Búsqueda MLS invoca el CLI
EasyBroker con credenciales `easybroker_web`. Si `storage-state.json` expira,
el CLI reintenta con email/password y sólo pide login asistido cuando EasyBroker
exige CAPTCHA/MFA o bloquea la automatización. Contrato de filtros MLS: campos
exactos (`bedrooms`, `bathrooms`, `parking_spaces`) para comparables, mínimos
(`min_bedrooms`, `min_bathrooms`, `min_parking_spaces`) para búsquedas de
opciones, y `shared_commission_only` para casos donde sólo interesan propiedades
que comparten comisión. Detalle: `realestate-credentials.ts`.

### 10.1 Doctrina de personalización: global code, account configuration

La regla base es: **las tools runtime viven como código global y reusable; la
personalización del cliente vive en datos/configuración por cuenta**.
Para una explicación conceptual de skills user-facing, skills de referencia,
tools técnicas y wrappers de negocio, ver
[`../skills-tools-architecture.md`](../skills-tools-architecture.md).

Orden recomendado antes de escribir código nuevo:

1. **Configuración/assets por cuenta**: plantillas DOCX, watermarks, logos,
   API keys, tokens, preferencias simples. Se modelan en tablas como
   `account_assets` o `account_tool_secrets`.
2. **Flow/policy por caso de uso**: `operational_flow_jsonb`,
   `activation_policy_jsonb` y `required_assets` declaran qué pasos,
   mensajes, pruebas y recursos requiere cada caso sin cambiar código.
3. **Skills por cuenta**: cuando cambia el playbook operativo de un cliente,
   se usa `account_skills`. La skill instruye y acota tools, pero no ejecuta
   código arbitrario.
4. **Tool global nueva**: se agrega código en el repo sólo cuando aparece una
   capacidad reusable para varias cuentas o casos (ej. render DOCX desde una
   plantilla, aplicar watermark, crear listing en un API externo).
5. **Código específico por usuario/cuenta**: evitarlo en V1. Si algún día es
   indispensable, debe vivir en un modelo explícito de sandbox/plugin con
   aislamiento, versionado, permisos, observabilidad y límites de recursos; no
   mezclado directamente en el runtime global.

Ejemplo: `generate_document_from_template` es una tool global. El contrato de
Alebrixe no es código: es un asset privado de esa cuenta. El mismo renderer
puede servir a otra cuenta si esa cuenta sube su propia plantilla y su flow
declara el `asset_key` correspondiente.

Perfil declarativo de assets:

- `TOOL_CATALOG[].asset_profile.account` describe assets persistentes que una
  tool necesita de forma genérica (ej. watermark de `image_watermark`).
- `TOOL_CATALOG[].asset_profile.test` describe assets temporales para pruebas
  individuales en Settings y qué argumento llenan (`param`, ej. `image_paths`).
- El flow del caso puede declarar `required_assets` / `test_assets` para cambiar
  labels, `asset_key`, límites o copy sin tocar código.
- `min_count`, `max_count` y `collection` permiten colecciones de archivos; la
  UI muestra un cargador compacto con "Agregar fotos" en vez de campos fijos.
  Para `easybroker_upload_images`, la prueba permite hasta 30 fotos temporales.

### 10.2 Orden de publicación EasyBroker

Para publicación real, el orden recomendado es:

1. `image_watermark` genera fotos marcadas en `account-assets` usando
   `listing_photo_watermark` u otro asset de watermark de la cuenta.
2. `easybroker_create_listing` crea la ficha con API key `easybroker` y debe
   mantenerse `risk='high'` / HITL. El payload base viene del paquete aprobado:
   título, descripción, operación, tipo, precio, ubicación, área y recámaras.
   Por seguridad se crea como `status=not_published` salvo override explícito.
   Si no recibe `agent`, usa como default el email guardado en
   `account_tool_secrets` para `easybroker_web`; EasyBroker resuelve ese email
   al usuario/agente visible en su panel.
3. `easybroker_upload_images` recibe el `listing_id` devuelto por create y
   adjunta las fotos generadas por `image_watermark` enviando URLs firmadas a
   EasyBroker. Para prueba aislada puede usar fotos temporales subidas desde UI
   como activos de prueba.

El adapter write debe guardar en el resultado IDs/URLs devueltos por EasyBroker
y registrar errores por imagen sin perder el listing ya creado. `create` devuelve
`public_url` (la liga pública/listing que entrega la API) y `agent_url` (derivada
para el panel interno `/agent/properties/{slug}`). La validación operativa mínima
es: dry-run/HITL del paquete aprobado → create listing → upload imágenes →
devolver URL de borrador/publicación para revisión humana.
Las fotos de publicación no son `account_assets` persistentes; son artefactos
operativos/caso. La limpieza automática de artefactos temporales queda pendiente
si no existe todavía un job/política para `tool-test-artifacts` o
`case-artifacts`.

Para validar la integración antes de correr el flow completo, Settings expone
una prueba real controlada de `easybroker_create_listing`: requiere escribir
`CREAR BORRADOR`, fuerza `status=not_published` y prefija el título con
`[PRUEBA - BORRAR]`. Si la prueba crea una ficha, se debe borrar manualmente en
EasyBroker al terminar la validación.

`easybroker_upload_images` también admite prueba real controlada: requiere
escribir `FOTOS A BORRADOR`, intenta reutilizar el último `listing_id` exitoso de
`easybroker_create_listing` para el usuario y, si no existe, exige que se indique
un `listing_id` real (no `REEMPLAZA-CON-LISTING-ID`). Usa las fotos temporales
resueltas desde `asset_profile.test`. EasyBroker reemplaza el arreglo de imágenes
de esa ficha, por lo que sólo debe usarse contra borradores de prueba.
El contrato real de EasyBroker valida `images[].url` con máximo 255 caracteres;
por eso el adapter no debe enviar signed URLs largas de Supabase directamente.
Cuando hay `NEXT_PUBLIC_SITE_URL` público (o `EASYBROKER_PUBLIC_ASSET_BASE_URL`),
manda una URL corta de Gu OS (`/api/public/account-assets/{id}/image.ext`) que
redirige temporalmente al objeto privado.

Entornos:

- **Local**: EasyBroker no puede abrir `localhost`. Para prueba real controlada de
  upload se debe exponer `localhost:3000` con un túnel HTTPS, por ejemplo
  `ngrok http 3000`, y configurar en `apps/web/.env.local`
  `EASYBROKER_PUBLIC_ASSET_BASE_URL=https://<subdominio-ngrok>` sin barra final.
  Reiniciar `npm run dev` después de cambiar env vars.
- **Producción / GCP**: configurar `NEXT_PUBLIC_SITE_URL` con el dominio público
  HTTPS de Gu OS (dominio propio, Load Balancer, Cloud Run público o el endpoint
  estable que corresponda). Si se quiere desacoplar EasyBroker del dominio
  canónico de la app, usar `EASYBROKER_PUBLIC_ASSET_BASE_URL` con una base pública
  equivalente. El endpoint `/api/public/account-assets/{id}/image.ext` debe ser
  accesible desde internet para que EasyBroker descargue las imágenes.

#### Contrato real observado de `POST /v1/properties`

El contrato operativo se basa en el OpenAPI Markdown publicado por EasyBroker en
`https://dev.easybroker.com/llms.txt` y validación real contra la cuenta. Puntos
importantes para no repetir la iteración:

- `operations[]` requiere `type`, `amount`, `currency` y `active`; para renta de
  largo plazo el `type` aceptado es `rental`. `unit` puede enviarse como `total`.
- `location.name` debe ser el string completo de ubicación registrada (por
  ejemplo `Colomos Providencia, Guadalajara, Jalisco`), compatible con
  `/v1/locations`.
- En `POST /properties`, `location` acepta campos de dirección como `name`,
  `street`, `postal_code`, `latitude` y `longitude`. No enviar ahí `city_area`,
  `city`, `region`, `type` o `full_name`; esos aparecen en respuestas/lookup,
  pero producen `422 Unpermitted parameters` en create.
- `show_exact_location` va top-level, no dentro de `location`.
- El endpoint crea siempre una ficha nueva (`POST`), no hace upsert. Repetir la
  prueba real controlada crea otro borrador.
- Para propiedades `not_published`, la UI de EasyBroker puede ordenar
  "Publicación más reciente" por `published_at` (nulo), mientras que
  "Actualización más reciente" usa `updated_at`; por eso un borrador recién
  creado puede aparecer primero sólo con orden por actualización.

---

## 11. Convenciones operativas

| Convención | Detalle |
|---|---|
| Canal `case_runner` | Nuevo valor agregado a `agent_sessions.channel_check`. Se usa en `runAgent({ channel: 'case_runner', caseId })`. |
| Sesión por caso | `getOrCreateSession(db, userId, 'case_runner', { caseId })`. Una sesión persistente por caso para auditoría unificada. |
| Idempotencia de eventos | Cuando el cron detecta una desincronización (ej. respuesta externa ya integrada), inserta un evento `state_changed` con `payload.reason: 'reconciled'`. |
| Bloqueo de tools fuera de allowlist | Igual que Heartbeat: el canal `case_runner` puede tener su propia allowlist conservadora si lo amerita. |
| Tracing | Cada turno del agente emite `AgentTurnEvent`; los eventos persistidos llevan `turn_id` correlacionado. |

---

## 12. Métricas y observabilidad mínimas

Para evitar casos zombie y degradación silenciosa:

- Casos abiertos por `case_type` y por edad (>7d, >30d, >90d).
- Tasa de completados vs fallidos por `case_type`.
- Tiempo promedio en cada `current_step`.
- Recordatorios enviados por caso (alertar si >3 sin respuesta).
- Locks no liberados (alertar si un caso está `for update` >5 min).

Implementación inicial: vistas SQL sobre `operational_cases` + `operational_case_events`. Dashboards visuales pueden venir después.

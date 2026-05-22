# Subsistema de Casos operacionales — Arquitectura

> Este documento sobrevive al plan. Describe **cómo funciona** el subsistema una vez implementado, separado del plan de ejecución y de las decisiones temporales.
>
> Plan asociado: [`plan.md`](plan.md). Consideraciones futuras: [`future-considerations.md`](future-considerations.md).

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

---

## 3. Ciclo de vida de un caso

```mermaid
stateDiagram-v2
  [*] --> active: usuario abre caso
  active --> waiting_external: agente pide algo a humano externo
  waiting_external --> active: respuesta entrante via webhook
  waiting_external --> active: timer vence + recordatorio enviado
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

  Cron->>DB: select for update skip locked<br/>where status in (active, waiting_external)<br/>and next_action_at <= now()
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

## 7. Notificación al humano interno

Capa nueva `notify(user_id, payload, urgency)`:

- Lee `user_notification_preferences.channels_priority_jsonb`.
- Decide canal según preferencia + presencia (sesión web reciente) + urgencia.
- Default actual: web si activo, Telegram si no.
- En el futuro: email, WhatsApp, push web.

Se usa siempre desde el agente o el cron cuando hay que avisarle algo al inmobiliario (recordatorio, aprobación pendiente, escalación, paquete listo).

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
| `account_assets` | Assets privados por cuenta requeridos por `operational_flow_jsonb.required_assets` (plantillas, watermarks, logos, etc.). El archivo vive en Supabase Storage y la tabla guarda metadata/ruta. |
| `GET/PUT/DELETE /api/account-tool-secrets` | CRUD sin exponer secretos en GET; PUT valida contra `apps/web/src/lib/account-tool-providers.ts`. |
| `POST /api/account-tool-secrets/[provider]/test` | Prueba de conexión por provider (API ping o sesión Playwright según provider); actualiza `status` y puede cerrar solicitudes abiertas en `global_tool_requests` para tools cubiertas por ese provider. |
| `global_tool_requests` | Migración `00023_global_tool_requests.sql`. Backlog cuando falta capacidad global o recurso de tenant; `GET/POST /api/global-tool-requests`. |
| `operational-case-tests` + `run-tool` | Casos de prueba por `case_type` con contexto de muestra (`test-context-samples.ts`); `POST …/run-tool` ejecuta una tool con args derivados del caso (opcional `case_id` para no usar siempre el último). |
| UI Casos de uso | **Preparación operativa**: revisar lista, expandir tool, conectar providers inline (mismo form que Ajustes), probar tool con vista previa legible de resultados. **Checks de activación**: checklist alineada con bloqueos de readiness. |
| UI Ajustes | **Conexiones** agrupa OAuth/vínculo (Google, GitHub, Telegram) y **Credenciales por cuenta** (API keys/tokens/credenciales web cifrados). |
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

### 10.2 Orden de publicación EasyBroker

Para publicación real, el orden recomendado es:

1. `image_watermark` genera fotos marcadas en `account-assets` usando
   `listing_photo_watermark` u otro asset de watermark de la cuenta.
2. `easybroker_create_listing` crea la ficha con API key `easybroker` y debe
   mantenerse `risk='high'` / HITL. El payload base viene del paquete aprobado:
   título, descripción, operación, tipo, precio, ubicación, área y recámaras.
3. `easybroker_upload_images` recibe el `listing_id` devuelto por create y sube
   las fotos generadas por `image_watermark`.

El adapter write debe guardar en el resultado IDs/URLs devueltos por EasyBroker
y registrar errores por imagen sin perder el listing ya creado. La validación
operativa mínima es: dry-run/HITL del paquete aprobado → create listing →
upload imágenes → devolver URL de borrador/publicación para revisión humana.

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

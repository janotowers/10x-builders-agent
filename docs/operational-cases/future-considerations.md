# Casos operacionales — Consideraciones futuras

> Este documento archiva las recomendaciones, umbrales y lecciones que **no** entran en el alcance de la primera versión del subsistema de casos, pero que conviene tener documentadas para evitar discusiones repetitivas más adelante.
>
> Plan de implementación: [`plan.md`](plan.md). Arquitectura: [`architecture.md`](architecture.md).
> Marco de pruebas: [`testing-framework.md`](testing-framework.md). Autoría NL: [`use-case-authoring-vision.md`](use-case-authoring-vision.md). Skill Lab: [`../skills-tools-architecture.md`](../skills-tools-architecture.md) §12.

---

## 0. Dos pistas de readiness (no confundir)

| Pista | Cuándo | Instrumentación |
|-------|--------|-----------------|
| **Preparación operativa N0–N5** | Casos multi-día con `current_step`, cron, esperas externas | Settings → Casos de uso; N5 = laboratorio E2E controlado (`agent_e2e`) |
| **Skill Lab** | Skills de un turno sin instancia de caso | Rúbrica `skill-authoring`, evals, N1 opcional en integraciones |

No exigir N4/N5 a skills síncronas. No activar casos operacionales sin N0–N2 mínimo. Quality bar instrumentable: [`testing-framework.md`](testing-framework.md) §13.

**Autoría de pasos:** un `step_key` es un hito de negocio durable; no crear un paso por cada **habilidad atómica** — la raíz compuesta orquesta dentro del hito ([`authoring-playbook.md`](authoring-playbook.md) §1).

---

## 1. Cuándo justificar subagentes

**Default:** un solo agente con un único reasoning loop, skills y tools acotados, runtime durable de casos. No multi-agente.

**Cuándo cambia el default:** cuando se cumple **al menos una** de estas condiciones de manera sostenida (no anecdóticamente):

| Condición | Por qué amerita subagente |
|---|---|
| **Paralelismo real necesario** | Ej. analizar 5 PDFs simultáneamente; cada subagente con su contexto. Single-agent serializa esto. |
| **Modelos materialmente distintos** | Ej. un subagente con modelo barato resumiendo, otro con modelo grande razonando. La fachada de modelos por canal cubre parte de esto sin multi-agente. |
| **Contextos aislados por privacidad/permisos** | Subagente que ve datos sensibles que el agente principal no debe ver. |
| **Especialización tan profunda que el prompt no escala** | Cuando se han agotado: progressive disclosure, splitting de skills, references on demand. |

**Antipatrones (no son razón válida para subagentes):**

- "Quiero más calidad" → casi siempre se resuelve con mejores skills, no con más agentes.
- "Quiero que hable con tono distinto" → eso es prompt/skill, no agente nuevo.
- "Quiero modularidad" → eso es composite skills + tools, no agentes.

**Lo que sí conviene tener listo antes de mover a multi-agente:**

- Telemetría de qué % del tiempo el agente principal se "estanca" en cierto tipo de subtarea.
- Eval suite por dominio para medir mejora real al subagentar.
- Modelo de costos: subagentes multiplican llamadas LLM; presupuestar.

---

## 2. Cuándo escalar el selector de skills

Hoy el selector vive en [`packages/agent/src/skills/select.ts`](../../packages/agent/src/skills/select.ts):

- Un modelo lateral barato (`gpt-4o-mini`).
- Recibe descripciones de skills + mensaje del usuario + routing context estructurado.
- Bias hacia `none`.
- 20 skills globales hoy.

**Umbrales para revisar el setup:**

| Umbral | Síntoma | Acción recomendada |
|---|---|---|
| **~30 skills totales (global + account)** | Descripciones empiezan a solaparse. | Pre-filtrado por `scope` + canal antes de pasar al selector. |
| **>5% selección incorrecta en producción** | Reportes de usuarios o tests de eval que fallan. | Implementar embeddings + top-K (ver abajo). |
| **>50 skills totales** | El prompt al selector se vuelve costoso y largo. | Definitivamente embeddings + top-K. |
| **Skills con nombres parecidos** (ej. `lead-momentum-watch` vs `lead-followup-draft`) | El selector confunde. | Editar descripciones para diferenciarlas explícitamente; `Use when ...` claro. |

**Alternativas en orden de complejidad creciente:**

1. **Pre-filtrado por scope/contexto** (gratis): si sé que el usuario está en business, no le paso skills personales. Aprovecha que `account_skills` traen `scope`.
2. **Routing context structured** (ya existe): forzar continuidad cuando el turno es follow-up. Cubrir más patrones de continuidad.
3. **Embeddings + top-K**: precomputar embeddings de descripciones; al turno, embeber el mensaje y sacar top-K (ej. 5) por similitud; pasar solo esos al selector LLM.
4. **Selector multi-stage**: primero clasificar dominio (`business|personal|none`), después seleccionar skill dentro del dominio.
5. **Selector con mejor modelo** (más caro): subir a Haiku o GPT-4o como selector.

**Mejor ROI según el momento:**

- Hoy → cuidar descripciones y bias `none`.
- ~30 skills → pre-filtrado por scope + embeddings + top-K.
- ~50 skills → multi-stage selector.
- Cambiar de modelo es lo último, no lo primero.

---

## 3. Cuándo evaluar motor durable tipo Temporal/Inngest

El subsistema de casos vive sobre **Postgres + cron + LangGraph checkpointer**. Es suficiente para los volúmenes y complejidad esperados a corto-medio plazo.

**Cuándo justifica migrar a Temporal/Inngest/Trigger.dev:**

| Condición | Por qué |
|---|---|
| **Miles de casos concurrentes activos por minuto** | Postgres + cron escala bien hasta cierto punto; un motor durable tiene mejor throughput y observabilidad nativa. |
| **Latencia inter-paso crítica (segundos vs minutos)** | El cron actual es periódico; un motor durable dispara workflow al instante. |
| **Requisitos de cumplimiento que exijan motor con auditoría certificada** | Algunos motores tienen audit trails formalmente probados. |
| **Múltiples idiomas/runtimes** | Si Gu OS expande a Python o Go, un motor durable es lenguaje-agnóstico. |

**Costos de migrar:**

- Otra dependencia operativa (otro servicio que monitorear, escalar, pagar).
- Doble fuente de verdad para state (postgres del subsistema + state del motor).
- Curva de aprendizaje del equipo.

**Antipatrón:** adoptar Temporal solo porque "es lo correcto" sin tener volumen ni necesidad. Aumenta superficie de fallo y costo operativo sin valor inmediato.

**Estrategia recomendada:** mantener interfaces del subsistema (queries, eventos) limpias y abstractas para que una eventual migración no requiera re-escribir las skills ni el agente.

**Antes de saltar a Temporal**, suele pagar agotar las palancas del diseño actual: frecuencia del cron, tamaño de lote leído de Postgres, `OPERATIONAL_CASES_CONCURRENCY`, y métricas de degradación. El comportamiento exacto del cron (cola en memoria, por qué la concurrencia no “tira” casos, qué pasa si hay más vencidos que el límite del lote) y una guía de **señales de degradación / qué hacer** están en [`architecture.md`](architecture.md), en la sección de procesamiento (subsecciones *Detalle: límite de lote…* y *Señales de degradación…*).

---

## 4. Browser automation a portales externos

**Default:** **NO** automatizar portales que no nos pertenezcan. El paquete listo para subida manual por el usuario es la opción correcta para Inmuebles24, Vivanuncios, etc.

**Por qué:**

| Riesgo | Detalle |
|---|---|
| Violación de Términos de Servicio | Casi todos los portales prohíben automatización no autorizada. |
| Suspensión de cuenta del cliente | Inmuebles24 detecta bots y suspende. La inmobiliaria pierde su canal principal de leads. |
| Fragilidad permanente | Cualquier cambio en HTML, captcha, o flujo de auth rompe la integración. |
| Captchas y MFA | Eventualmente los meten; la automatización deja de funcionar. |
| Custodia de credenciales del cliente | Activo crítico que hay que cifrar, rotar, auditar. |
| Imagen del producto | Si Gu OS es asociado con "bot que publica en portales", puede haber rechazo de la industria. |

**Excepciones legítimas:**

- **Sistemas propios** (Ungga): ver POC Ungga CLI/API en [`plan.md`](plan.md) sección 6. Aquí Gu OS es dueño del sistema, no hay terceros.
- **EasyBroker MLS (bolsa inmobiliaria)**: la API pública no cubre búsqueda en la bolsa completa; Gu OS usa Playwright con credenciales web del cliente (`easybroker_web` en `account_tool_secrets`, POC `pocs/easybroker-mls-cli/`). Mismos guardrails que abajo: cifrado, prueba de conexión, storage state, HITL en writes, fallback manual si rompe UI o reCAPTCHA. **No** extender este patrón a Inmuebles24 u otros portales sin partnership.
- **Evolución cercana (EasyBroker MLS)**: hoy `easybroker_search_listings` y `easybroker_search_closed_deals` pueden abrir sesiones Playwright separadas en el mismo tick. Evaluar un modo batch/sesión compartida (abrir login una vez, correr ambas búsquedas con filtros distintos, persistir storage una vez) para reducir latencia y variabilidad por anti-bot. Mantener trazabilidad separada por búsqueda en el artefacto final.
- **Partnerships oficiales**: si Inmuebles24 ofrece API B2B/partner program, esa es la vía correcta. Buscar antes de automatizar.

**Si en el futuro se decide automatizar (con aprobación explícita y documentada del cliente):**

1. Consentimiento escrito del cliente.
2. Credenciales del cliente almacenadas con cifrado a nivel de aplicación.
3. Account separada por cliente, nunca compartida.
4. Throttling agresivo y `User-Agent` honesto.
5. Eval suite para detectar cambios de UI antes de que rompan.
6. Plan de fallback claro cuando rompa (notificar al cliente, hacer manual).
7. Métricas de éxito por cliente.

**El POC contra Ungga es el lugar correcto para aprender Playwright** sin asumir riesgo legal/operativo.

---

## 5. WhatsApp Cloud API: cuándo y cómo

**Default V1:** Telegram para todo el outbound proactivo. Es trivial sobre lo que ya tenemos.

**Cuándo justifica WhatsApp Cloud API:**

- El cliente piloto (Alebrixe) reporta que sus dueños/leads no usan Telegram en absoluto.
- Hay >10 cuentas demandando outbound automático por WhatsApp.
- El equipo está dispuesto a invertir 5-10x el esfuerzo de Telegram.

**Lo que implica adoptar WhatsApp Cloud API:**

| Requisito | Detalle |
|---|---|
| Cuenta business verificada | Meta Business Manager verificado, número WhatsApp Business dedicado. |
| Plantillas pre-aprobadas | Para mensajes proactivos fuera de la ventana de 24h: templates aprobados por Meta (días-semanas de revisión). |
| Webhooks para inbound | Endpoint nuevo + verificación de firma. |
| Manejo de la "ventana de 24h" | Después de 24h sin interacción del usuario, solo plantillas; no texto libre. |
| Costos | Por conversación (no por mensaje), variable por país. |
| Compliance | Política de uso de Meta, opt-in explícito de cada usuario externo. |

**Roadmap recomendado cuando llegue el momento:**

1. Validar con piloto Telegram primero. Si Telegram no convierte, WhatsApp tampoco va a salvar el caso.
2. Onboarding de Meta Business Manager para Ungga + provisioning del número.
3. Implementar inbound (`/api/whatsapp/webhook`) y validar.
4. Plantillas mínimas: recordatorio_documentos, confirmacion_visita, paquete_listo.
5. Tool `whatsapp_send_message` con dispatch a plantilla cuando aplique.
6. Aislamiento detrás de `notify(user_id, payload, urgency)` y de las tools del agente para que las skills no sepan si el canal final es Telegram o WhatsApp.

---

## 6. Evoluciones futuras de `account_skills`

V1 (este plan) es deliberadamente mínimo: una tabla, runtime que la considera, UI textarea-básica.

**V2 — versionado y publishing flow:**

- `account_skills` con histórico de versiones (tabla separada `account_skill_versions`).
- Estados `draft → review → active → archived` con rollback.
- QA pre-publicación: validar que `allowed_tools` están en el catálogo, que `includes` resuelven, que el frontmatter es válido.
- UI con preview lado a lado del cuerpo y diff vs versión activa.

**V3 — compartir entre cuentas de la misma organización:**

- Cuando exista la tabla `organizations` y `memberships`, permitir que una skill viva a nivel `organization_id`, no solo `user_id`.
- Reglas de visibilidad: skills personales (solo el autor), skills de organización (todos los miembros), skills shared (público dentro de la org).
- Migración desde `account_skills` (user-level) a `organization_skills` con preservación de slug.

**V4 — promoción HITL desde Brain Layer:**

- `brain_skill_candidates` (ver [`docs/brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md)) propone una skill nueva basada en patrones observados.
- Humano revisa, edita, aprueba.
- Promoción automatizada a `account_skills` o `organization_skills` según el contexto.

---

## 7. Conexión con Brain Layer (Pattern → Skill → Workflow → Case)

El Brain Layer (en plan separado) introduce capas: Acquisition, Memory, Graph, Signal, Pattern, Skill, Workflow.

Los **casos operacionales** son la materialización concreta de la capa **Workflow**:

```mermaid
flowchart LR
  PAT["Pattern Layer<br/>brain_skill_candidates"]
  SKL["Skill Layer<br/>account_skills + global"]
  CASE["Workflow Layer<br/>operational_cases (instancias)"]

  PAT -- "HITL aprueba candidato" --> SKL
  SKL -- "se asocia a case_type" --> CASE
  CASE -- "instancias generan eventos" --> SIG["Signal Layer (entrante)"]
  SIG -- "agregaciones forman" --> PAT
```

Implicaciones:

- Cuando exista la capa Pattern, los **eventos de casos** (recordatorios respondidos, casos completados rápido vs lento, escalaciones frecuentes) alimentan la mineration de patrones.
- Los **patrones aprobados** producen nuevas skills o variantes de skills existentes.
- Las nuevas skills pueden **mejorar el comportamiento de futuras instancias** del mismo `case_type`.

Esto convierte el subsistema de casos en parte de un loop de aprendizaje organizacional, no solo en un motor de ejecución.

---

## 8. Cosas que decididamente NO hacemos en V1

Para evitar scope creep:

- **No subagentes** (ver sección 1).
- **No motor durable externo** (ver sección 3).
- **No browser automation genérica a portales externos** (Inmuebles24, etc.; ver sección 4). Excepción acotada ya en producto: EasyBroker MLS (`easybroker_web`) y Ungga (`ungga` / `ungga_api`).
- **No WhatsApp Cloud API** (ver sección 5).
- **No `account_skills` con versionado completo** (V2+).
- **No mining automático de patrones desde casos** (Brain Layer fase posterior).
- **No multi-tenancy a nivel `organizations`** (queda como V3+).
- **No editor visual de skills WYSIWYG** (textarea + validación es suficiente para V1).
- **No selector de skills sofisticado** (el actual basta a esta escala; ver sección 2).

---

## 9. Tools configurables por cuenta

V1 mantiene los adapters en código para las herramientas comunes y críticas. Para tools muy específicas de una cuenta, el diseño recomendado no es agregar código custom por cliente, sino exponer primitives genéricas y configurarlas desde Supabase.

**Principio:** el repo contiene adapters genéricos seguros; la cuenta guarda configuración, secretos, schemas y política HITL.

**Implementación parcial en el repo (2026-05):** ya existe `account_tool_secrets`
(migración `00024_account_tool_secrets.sql`) como tabla genérica **una fila por
`(user_id, provider)`** con `config_jsonb` + secretos cifrados, más catálogo en
código (`apps/web/src/lib/account-tool-providers.ts`), API REST bajo
`/api/account-tool-secrets`, pruebas de conexión y wiring en readiness/UI.
Esto cubre providers concretos (p. ej. `easybroker`, `easybroker_web`, `ungga_api`,
`ungga`) **antes** del
modelo más rico con `account_tool_configs` + primitives y `account_tool_test_runs`
descrito abajo. Cuando se evolucione a primitives genéricas, conviene migrar o
convivir: el contrato de readiness (`/api/tool-readiness`) ya está pensado para
combinar catálogo global + estado por cuenta.

Primitives reutilizables:

| Tool genérica | Uso |
|---|---|
| `custom_http_request` | Llamar APIs privadas con método, URL base, auth y schema controlado. |
| `custom_query_runner` | Ejecutar queries parametrizadas contra fuentes permitidas por cuenta. |
| `template_renderer` | Renderizar documentos desde templates versionados por cuenta. |
| `webhook_call` | Disparar webhooks simples con payload validado. |

Modelo de datos sugerido:

| Tabla | Campos principales |
|---|---|
| `account_tool_configs` | `id`, `user_id`/`organization_id`, `tool_id`, `display_name`, `primitive`, `status`, `risk`, `requires_hitl`, `input_schema_jsonb`, `response_mapping_jsonb`, `timeouts_jsonb`, `created_at`, `updated_at`. |
| `account_tool_secrets` | `tool_config_id`, `secret_ref` o `encrypted_secret`, `kind`, `rotated_at`. Separada para minimizar exposición accidental. |
| `account_tool_test_runs` | `tool_config_id`, `status`, `input_jsonb`, `result_jsonb`, `error`, `created_at`. Sirve para readiness y auditoría. |

Readiness debería evaluar:

- La configuración existe y está `active`.
- El schema de entrada es válido y tiene límites razonables.
- Secretos requeridos existen y no están vencidos.
- El risk/HITL coincide con la operación: write/send/publish nunca auto-run sin confirmación explícita.
- El último test run fue exitoso o, si no existe, la UI lo marca como “requiere prueba”.

Reglas de seguridad:

- Nunca permitir URL libre generada por el modelo; la base URL y rutas permitidas vienen de configuración revisada.
- Validar payload con `input_schema_jsonb` antes de ejecutar.
- Redactar secretos en logs, eventos, tool calls y errores.
- Rate limits por tool y por cuenta.
- Para `custom_query_runner`, solo queries parametrizadas y allowlist de datasets/tablas.
- Para `custom_http_request`, bloquear redes privadas salvo allowlist explícita.

Estrategia de adopción:

1. Mantener `TOOL_CATALOG` como fuente de verdad para tools globales.
2. Agregar un segundo catálogo runtime para `account_tool_configs`.
3. Hacer que `tool-readiness` combine ambos catálogos.
4. Permitir que `allowed_tools` referencie `account:<tool_id>` o slugs namespaced equivalentes.
5. Añadir UI de configuración/prueba antes de permitir que una skill activa use esa tool.

---

## 10. Consolidar adapters conversacionales (Telegram / web / WhatsApp)

**Estado actual (2026-06):** la paridad operacional entre canales ya está
cerrada en los motores compartidos:

| Motor | Módulo | Usado por |
|-------|--------|-----------|
| Intención + creación/adopción de caso | `conversational-case-orchestrator.ts` → `resolveConversationalCaseForChannel` | **Web** (paso 2 del `/api/chat`) |
| Intake determinístico | `conversational-intake-orchestrator.ts` | Telegram + web |
| Routing / aclaración multi-caso | `conversational-routing-orchestrator.ts` | Telegram + web |
| Tick E2E post-intake | `conversational-e2e-post-intake.ts` | Telegram + web |
| Ingestión de documentos de caso | `case-document-ingestion.ts` | Telegram (contacto externo); WhatsApp reutilizará la misma pipeline |

**Deuda técnica menor que queda:** el webhook de Telegram (`apps/web/src/app/api/telegram/webhook/route.ts`) aún tiene un **bloque inline** en el paso 2 que duplica la orquestación que web ya delega a `resolveConversationalCaseForChannel`. La lógica de negocio es equivalente (misma detección de intención, mismo `ensureConversationalCase`, mismo `forceNew`, mismo linkage E2E), pero Telegram conserva código adapter-específico inline porque:

1. Pasa `labTelegramChatId` para simular el contacto externo en E2E.
2. Hace `upsertConversationBinding` con `chatId` + `sessionId` explícitos.
3. Envía el primer prompt de intake por Telegram y responde con rutas del webhook.

**No es un gap funcional** — ambos canales se comportan igual en producción. Es
refactor de estructura para reducir riesgo de divergencia futura al editar solo
uno de los dos caminos.

**Cuándo conviene hacerlo:**

| Gatillo | Por qué |
|---------|---------|
| **Agregar WhatsApp** como canal conversacional | Evitar copiar el bloque inline de Telegram; un adapter común con `channelContext` (chatId, sessionId, lab external contact) beneficia a N canales. |
| **Editar el paso 2 de intención/creación** y notar que hay que tocar dos sitios | Señal de que la duplicación ya cuesta mantenimiento. |
| **Refactor general de adapters** | Oportunidad natural para unificar sin prisa. |

**Dirección del refactor (cuando toque):**

Extender `resolveConversationalCaseForChannel` (o un wrapper `resolveConversationalCaseForMessagingChannel`) con contexto opcional de canal:

```ts
channelContext?: {
  chatId?: number;           // Telegram / WhatsApp
  sessionId?: string;        // agent_sessions
  labExternalChatId?: number; // E2E: contacto externo simulado
}
```

El motor compartido devuelve `{ case, created, explicitIntent, ... }`; el adapter
solo envía mensajes (Telegram `sendTelegramMessage`, web `addMessage` + JSON).

**Qué NO mover al motor compartido:** envío de mensajes, formato UX de
aclaración por canal, descarga de archivos del API de Telegram, ticks E2E que
disparan `runSettingsTestCaseAgentTick` con side-effects de canal.

**Referencias en código:**

- Función compartida: `apps/web/src/lib/operational-cases/conversational-case-orchestrator.ts`
- Bloque inline pendiente: `apps/web/src/app/api/telegram/webhook/route.ts` (~paso 2, `explicitPropertyIntent`)
- Paridad web: `apps/web/src/app/api/chat/route.ts`

**Validación post-refactor:** re-ejecutar selftests de routing/intake + smoke E2E
lab (crear caso, intake, aclaración multi-caso, documento por Telegram como
contacto externo).

---

## 11. Solicitud de documentos: rutas y vinculación externa

**Estado (2026-06):** el MVP soporta `document_request_target` en dos rutas:

- `internal_user` (sube documentos el asesor/equipo interno).
- `external_contact` (se solicita al contacto externo por mensajería).

El modo `both` queda explícitamente **fuera de alcance** por ahora (ver abajo).

### Comportamiento actual (implementado)

| Escenario | Qué pasa |
|---|---|
| Post-intake | Un solo mensaje: confirmación de propiedad + checklist + privacidad + «interno» / «externo». |
| Asesor elige «interno» | `waiting_internal`; sube docs y confirma «listo». |
| Asesor elige «externo» y **ya** hay contacto verificado | Cron/agente envía solicitud inicial al `chat_id` externo. |
| Asesor elige «externo» **sin** contacto verificado (Real) | Subflujo de setup: token + deep link `t.me/<bot>?start=ec_<token>`; el asesor reenvía al contacto; al abrirlo queda verificado y continúa el flujo externo. **No** se responde «elige interno». |
| Asesor sube documentos **antes** de elegir destino | Se infiere `internal_user` (`decided_by=inferred`); acuse consolidado; no se repite la pregunta por archivo. |
| E2E lab + «externo» | Contacto externo simulado/cableado; no requiere deep link. |

Referencias: `document-request-target.ts`, `case-document-collection.ts`,
`external-contact-link.ts`, migración `00049_external_contact_link_tokens.sql`.

### Modo `both` (pendiente)

El modo `both` queda explícitamente **fuera de alcance** por ahora.

### Por qué no entra en el MVP

Con `both`, el sistema deja de poder avanzar sólo por señal “listo” de una
fuente. Se necesita un control explícito de completitud por documento y por
origen para evitar falsos positivos de avance.

### Diseño recomendado para futura implementación

1. Extender `document_request_target` con `both`.
2. Crear checklist por caso (documentos requeridos/ideales) con estado por ítem:
   - `missing`, `received`, `accepted`, `rejected`, `waived`.
3. Mantener provenance por fuente:
   - `advisor_web`, `advisor_telegram`, `external_telegram`, (futuro) WhatsApp.
4. Reglas de dedupe:
   - hash (`sha256`) + `kind` + superseded/reemplazo.
5. Criterio de avance:
   - sólo por checklist completo o override humano explícito
     (“continuar con documentos disponibles”).

### Guardrails al implementarlo

- No inferir completitud total sólo por texto libre “listo”.
- Si una fuente marca “listo”, tratarlo como cierre de **esa fuente** y no del
  expediente completo.
- Mostrar en UI qué documentos faltan y de qué fuente se espera cada uno.

---

## 12. Contrato por email y Gmail: evoluciones diferidas

**Estado (2026-06):** el paso `contract_pending` envía el borrador al dueño por
Gmail OAuth del asesor (`gmail.send`), con adjunto y link de respaldo. Tras el
envío HITL el caso avanza a `photos_requested`; la firma del dueño queda fuera
del flujo operativo por ahora. Las correcciones del asesor entran por chat web o
Telegram (adjunto conversacional), no por formulario en el inbox.

Referencias del comportamiento actual: [`operational-case-reusable-patterns.md`](operational-case-reusable-patterns.md) (patrón contrato), [`testing-framework.md`](testing-framework.md) (escenarios N4), `contract-review.ts`, `send-message.ts`.

### Gmail read / bandeja (fuera de alcance V1)

Hoy sólo se pide scope `gmail.send` para enviar correos aprobados por HITL. **No**
hay lectura de bandeja ni tools de agente sobre threads entrantes.

| Opción futura | Cuándo considerarla |
|---|---|
| Scope `gmail.readonly` + tool `gmail_list_threads` / `gmail_get_message` | Cuando el producto necesite detectar respuestas del dueño (p. ej. «firmado», adjunto devuelto) sin intervención manual |
| Cron / webhook de inbound | Cuando el volumen o la latencia hagan inviable polling desde el agente |
| Confirmación HITL antes de enviar (ya existe) | Mantener para cualquier `gmail.send`; no auto-enviar desde el LLM |

**Guardrails:** separar OAuth de envío (`provider=gmail`) de una futura integración
de lectura si los scopes divergen; documentar en GCP que hay que habilitar Gmail
API además de Calendar (ver README). No mezclar envío de contrato con tools
genéricas de bandeja hasta definir riesgo y auditoría.

### Firma del dueño in-flow (diferida)

El hito principal de N4 es **envío por email** (`contract_sent_to_owner_email`),
no la firma. Tras aprobar envío, el caso pasa a `photos_requested` y la
publicación exige ese evento, no `contract_signed`.

Queda preparado para laboratorio:

- Decisión HITL `contract_owner_signed` y escenario `contract_pending_owner_signed`
  (`counts_toward_step_milestone: false` en el registry de pruebas).
- Handler en `contract-owner-signed.ts` para simular cierre por firma en N4.

**Cuándo reabrir:** si el negocio exige bloquear fotos o publicación hasta firma
registrada en sistema (upload del contrato firmado, e-sign externo, o señal
verificada por email). Entonces habría que reintroducir `contract_signed` como
gate, definir fuente de verdad (manual vs. detección inbound) y alinear skills de
publicación.

### Links cortos de descarga en BD (mejora UX)

Hoy los correos incluyen URL firmada de Storage con nombre de archivo amigable
(`generated-case-document.ts`). Funciona, pero la URL puede ser larga y expira.

**Diseño recomendado para más adelante:**

1. Tabla `operational_case_document_links` (token opaco, `document_id`, `expires_at`, uso opcional único).
2. Ruta pública corta `/d/<token>` que redirige o sirve el archivo con el mismo
   nombre amigable.
3. Rotación / revocación al reemplazar `contract_draft` en una revisión.

No es bloqueante para el flujo actual; priorizar si usuarios se quejan de links
rotos en clientes de correo o si se necesita analytics de apertura.

### Correcciones por inbox web (explícitamente no)

El producto **no** incluye formulario en pending inbox para subir contrato
corregido. Si en el futuro se pide, tratarlo como feature aparte (duplicaría
canales con chat/Telegram y habría que unificar validación MIME y reenvío).


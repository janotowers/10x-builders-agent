# Conversational case intake — auditoría previa a Fase A

**Estado:** histórico — auditoría previa al rollout. La arquitectura vigente
está consolidada en [`architecture.md`](architecture.md) §6.1; no usar este
archivo como backlog de Studio ni como contrato actual del router.
**Audiencia:** producto + ingeniería antes de tocar skills o router.
**Pregunta que responde:** ¿Qué tan lejos estamos hoy de que un usuario
escriba en Telegram “necesito opcionar una propiedad” y el sistema arme
un `operational_case` end-to-end, sin pasar por `/operational-cases`?

> Conclusión adelantada: estamos más cerca de lo que pensábamos. La
> mayor parte del cableado existe y se diseñó pensando en este flujo.
> Lo que falta es **validarlo en vivo** y cubrir 3 huecos chicos. NO
> hay que rehacer router ni skill.

---

## 1. Cómo entra un mensaje hoy (canal Telegram)

`apps/web/src/app/api/telegram/webhook/route.ts` — flujo del `POST`:

1. Verifica `x-telegram-bot-api-secret-token`.
2. Si el update es `callback_query` (botones HITL): resume el agente con
   `resumeDecision=approve|reject` y termina.
3. Si el `chat_id` del mensaje coincide con `external_contact_jsonb.chat_id`
   de algún `operational_case` activo (lookup
   `findOperationalCaseByExternalChatId`), se trata como **respuesta del
   externo** (el dueño de la propiedad, p. ej.): se asocia el mensaje al caso
   vía `associateExternalResponseWithCase` y se sale con acuse de recibo. El
   procesamiento real lo hace el cron de `/api/cron/operational-cases` en
   el siguiente tick.
4. Si el `telegram_user_id` está en `telegram_accounts`, es un **usuario
   de Gu** hablando con su bot. Se busca/crea su `agent_sessions` con
   `channel='telegram'` y se llama `runAgent(...)` con `caseId=undefined`
   (no atado a ningún caso).

**Implicación:** cuando tú escribes a tu bot, llegas al mismo `runAgent`
que el chat web. Ese branch ya pasa por el selector de skills y por el
catálogo completo de tools del usuario. **No hay un "modo case-runner"
para mensajes de usuario, sólo para el cron.** Esto está bien y es lo
que queremos.

## 2. Cómo se elige skill por turno (selector de intención)

`packages/agent/src/skills/select.ts` + `packages/agent/src/graph.ts`
(branch L1075-L1209):

1. `runAgent` arma `registry = getSkillRegistryForUser(db, userId)` →
   merge de skills globales (repo) + skills de cuenta (Supabase
   `account_skills`). Las de cuenta ganan en colisión de slug.
2. `candidateSlugs = buildEnabledSkillCandidateSlugs(...)` → filtra por
   `user_skill_settings`. **Default ON**: si el usuario no marcó nada en
   `user_skill_settings`, todas las skills del registry son candidatas.
3. `selectSkillForTurn({ userMessage, registry, candidateSlugs, model,
   channel, routingContext })` → un LLM aparte recibe la lista de
   `name + description` de cada candidata y el mensaje del usuario, y
   devuelve `{ skill: "<slug>" | "none" }`.
4. El system prompt del selector dice **“pick a skill only when the
   description’s `Use when ...` clause clearly matches the user's
   intent”** y sesga hacia `none`.

**Implicación:** para que `property-optioning-coach` se active por
"necesito opcionar una propiedad", su `description` tiene que ser
inequívoca para el selector. Hoy dice:
*"End-to-end coach for the 'opcionar propiedad' workflow used by real
estate agencies. Use when the case_type is `property_optioning`. …"*
La frase "Use when the case_type is X" está pensada para el branch
`caseId` (binding directo), no para enrutar desde texto libre. **Riesgo
real:** el selector LLM puede devolver `none` o elegir otra skill
porque no ve la conexión semántica "opcionar propiedad" ↔ "property
optioning workflow". Hay que **validarlo en vivo** y, si falla,
reforzar la `description`.

## 3. Cómo se ata el agente a un caso (binding directo)

`packages/agent/src/graph.ts` L980-L1035:

- Si `runAgent` recibe `caseId`, carga `operational_cases` +
  `operational_case_types` y **fuerza** `activeSkill =
  caseType.default_skill_slug` saltándose el selector.
- También construye el bloque `[Caso operacional activo]` y lo
  concatena al system prompt: incluye `case_id`, `case_type`,
  `display_name`, `current_step`, `version`, política de recordatorios,
  últimos eventos.

**Quién pasa `caseId` hoy:**

- `apps/web/src/app/api/cron/operational-cases/route.ts` (cron del
  subsistema). Sí.
- `apps/web/src/app/api/chat/route.ts` (chat web del usuario). **No** —
  cada turno entra sin caseId, igual que Telegram.
- `apps/web/src/app/api/telegram/webhook/route.ts` (bot). **No** para
  mensajes de usuario; sólo asocia mensajes externos al caso pero no
  reactiva el agente con caseId desde el webhook (lo hace el cron).

**Implicación clave:** cuando el usuario escribe en Telegram o web, NO
estamos pasándole un caseId al agente. Eso es lo correcto, porque
queremos que la skill decida si hay un caso que continuar o uno que
crear. Pero significa que la skill tiene que **saber detectar si la
conversación ya está creando/continuando un caso** sin tener un campo
del system prompt que lo diga.

## 4. Cómo crea un caso una skill (tool `operational_case_create`)

`packages/agent/src/tools/operational-cases-adapters.ts` L68-L191:

- La tool valida que el `case_type` exista para el usuario via
  `getOperationalCaseTypeForUser`, que prefiere la versión de cuenta
  sobre la de producto cuando ambas existen (mismo desambiguador que ya
  usamos en `/operational-cases`).
- Valida required fields contra `intake_schema_jsonb` del case_type.
- Si faltan, devuelve un JSON estructurado con `error:
  "missing_required_intake_fields"` + `missing: [{name, label}, …]` +
  `hint: "Ask the user for these fields conversationally before
  retrying."` **Esto es exactamente lo que el LLM necesita para preguntar
  uno por uno.**
- `toolEnabled(...)` es **default ON**: si la skill tiene la tool en
  `allowed_tools` y el usuario no la marcó OFF, está disponible.

## 5. Estado de la skill `property-optioning-coach`

`skills/global/property-optioning-coach/SKILL.md`:

- `allowed_tools` incluye `operational_case_create`,
  `operational_case_update_state`, `operational_case_add_event`,
  `notify_user`, `telegram_send_message_to_contact`, comparables,
  EasyBroker, calendar, documentos, watermark, ungga_publish. **Completo.**
- Sección **"Camino conversacional (sin `case_id` en contexto)"** ya
  existe (líneas 65-76) y dice literalmente: *"Si el usuario pide
  iniciar 'opcionar propiedad' por chat/Telegram y no hay caso en el
  prompt, pregunta los campos required del intake_schema…"*.
- Workflow paso 1 dice *"si no hay bloque, ejecuta la sección Camino
  conversacional hasta tener `case_id`, luego continúa."*.

**Lo bueno:** alguien ya pensó en esto. La skill está casi lista.
**Lo no validado:** que el LLM ejecutándola realmente entienda la
instrucción y haga la llamada speculativa correcta a
`operational_case_create` para descubrir el schema.

## 6. ¿El LLM conoce el `intake_schema` antes de llamar la tool?

**No.** El system prompt no incluye los `intake_schema_jsonb` de los
case_types disponibles del usuario. El LLM tiene 2 caminos:

A. Llamada **speculativa** a `operational_case_create` con
   `{case_type:'property_optioning', context:{}}`. La tool devuelve
   `missing` con `name` + `label` de cada campo requerido. El LLM lee
   eso y pregunta uno por uno. Funciona; cuesta 1 round trip extra y
   una row de auditoría con error esperado.

B. **Inyectar** los intake schemas en el system prompt del turno
   cuando hay case_types activos para ese usuario. Más eficiente,
   menos errores fantasma en `tool_calls`, mejor UX (el LLM no se
   confunde sobre los nombres exactos de campos).

**Recomendación:** empezar con A para validar end-to-end; pasar a B
sólo si A muestra problemas. La skill ya está escrita para A.

## 7. ¿Cómo se ve el caso creado en `/operational-cases`?

- Cuando `operational_case_create` crea el row, inserta un evento
  `step_completed` con `payload.kind='case_created'` y
  `payload.source='agent_conversation'`. El campo `context_jsonb` que
  guarda **no** marca `created_from` automáticamente (a diferencia del
  formulario web, que mete `created_from:'web_operational_cases_ui'`
  en el context).
- La UI de `/operational-cases` lo va a mostrar como un caso normal,
  sin distintivo. Eso está OK para Fase A pero conviene agregar un
  badge "Creado por chat" cuando `payload.source='agent_conversation'`
  esté en el primer evento del caso.

## 8. Mapa de gaps reales (priorizado)

### Gap 1 — `description` de la skill puede no enrutar (RIESGO ALTO; trivial de arreglar)
La descripción actual habla en términos técnicos ("Use when the case_type
is `property_optioning`"). El selector LLM puede no asociar "necesito
opcionar una propiedad" → `property_optioning`. **Acción:** reforzar el
`description` con un párrafo `Use when:` que liste sinónimos en español
("opcionar una propiedad", "conseguir la exclusiva", "firmar la
comisión", "publicar una casa"). Fix de 5 líneas. Validar con un
selector self-test.

### Gap 2 — Validación end-to-end en vivo nunca se hizo (RIESGO ALTO; el más importante)
Toda la lógica existe en teoría. Nadie ha confirmado que un mensaje
real cruce: Telegram → selector → property-optioning-coach →
operational_case_create speculativo → pregunta conversacional →
creación real → `/operational-cases` muestra el row → cron lo retoma.
**Acción:** script de prueba manual de ~5 minutos con casos clave.

### Gap 3 — El LLM tiene que adivinar el intake_schema (RIESGO MEDIO; opcional)
Camino A funciona pero gasta 1 llamada extra y deja un `tool_call`
con error en la auditoría. Camino B (inyectar schemas al system prompt)
es más limpio. **Acción:** dejar para después de validar A. No bloquea
Fase A.

### Gap 4 — UI no distingue casos conversacionales (RIESGO BAJO)
Conviene un badge "Conversacional" en `/operational-cases` cuando el
primer evento del caso tiene `payload.source='agent_conversation'`. Es
útil para que tú audites el flujo. **Acción:** 10 líneas en `page.tsx`.

### Gap 5 — Router ve skills, no case_types (RIESGO BAJO HOY, ALTO MAÑANA)
Si en el futuro hay N case_types con sus N skills, el selector LLM ve
sólo skills. Eso funciona por coincidencia de que skill ↔ case_type es
1:1. Si dos case_types comparten skill, o un case_type no tiene skill
propia (sólo includes), el selector no los vería. **Acción:** ninguna
en Fase A. Documentar como deuda en `future-considerations.md`.

### Gap 6 — Sesión Telegram no recuerda "estoy a media creación de caso" (RIESGO MEDIO)
El selector LLM corre por turno. Si el usuario dice "opcionar
propiedad" (turno 1, selecciona property-optioning-coach), y luego en
turno 2 contesta "Av. Reforma 123", el selector reevalúa con el
mensaje literal "Av. Reforma 123". Riesgo: que en turno 2 el selector
devuelva `none` (porque "Av. Reforma 123" no matchea ningún `Use when`)
y la conversación pierda contexto. El **routingContext** existe
(`packages/agent/src/skills/routing-context.ts`) precisamente para
esto, pero hay que confirmar que se persiste y se aplica en el branch
de Telegram. **Acción:** verificar en el script de prueba; si se
pierde el contexto, ajustar.

## 9. Plan de Fase A (revisado tras auditoría)

Cambia significativamente respecto al plan original. La mayoría del
trabajo ya está hecho; lo que toca es **validar y ajustar**, no
construir desde cero.

**A1 — Reforzar `description` de `property-optioning-coach`** (15 min)
Agregar `Use when:` en español con sinónimos coloquiales. Validar con
`select.selftest.ts` (existe el self-test, sólo agregar casos).

**A2 — Script de prueba manual end-to-end** (30 min de redacción +
ejecución contigo en Telegram)
Pasos exactos a teclear, qué respuestas esperar, dónde mirar logs.
Sin esto no podemos decir "Fase A está hecha".

**A3 — Verificar `routingContext` en branch Telegram** (depende de
A2; si A2 pasa con turnos múltiples, A3 ya está cubierto sin tocar
nada).

**A4 — Badge "Conversacional" en `/operational-cases`** (15 min;
opcional, fuera del happy path; lo podemos meter después).

**Lo que se cae del plan original:**
- Crear skill `operational-case-intake` reusable: la skill compuesta
  ya hace el intake en línea, no hace falta extraer.
- Modificar `property-optioning-coach` para añadir el paso de
  intake: ya está.
- Alinear router de intenciones: ya está alineado, sólo hay que
  validar la descripción.
- Alinear handler de Telegram: ya pasa por el mismo runAgent que el
  chat web.

**Lo que SÍ se mantiene del plan original:**
- Validación end-to-end manual con script (A2).
- Visibilidad en `/operational-cases` (A4).

## 10. Riesgos no técnicos

- **Tono conversacional**: la skill dice "pregunta los required uno
  por uno" pero no especifica el tono. El LLM va a improvisar. Si el
  usuario quiere algo formal/informal específico, hay que afinar el
  guardrail.
- **Cancelación**: ¿qué pasa si el usuario dice "olvídalo, mejor no"
  a media creación? La skill no contempla un *abort path*. Bajo
  riesgo (el caso simplemente no se crea), pero conviene mencionarlo
  al usuario para que decida si quiere un *abort path* explícito.
- **Edición posterior**: si el usuario dice "espera, el chat_id es
  otro", el LLM tiene que recordar lo ya recolectado y sólo
  sobrescribir el campo cambiado. Esto cae en la habilidad
  conversacional del modelo; validar en A2.

---

**Próximo paso:** producto revisa este doc y aprueba arrancar con A1
+ A2. A4 lo decidimos después de ver el resultado de A2.

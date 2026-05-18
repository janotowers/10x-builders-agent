# Script de prueba end-to-end — Conversational case intake (Fase A)

**Audiencia:** producto (Janot) ejecuta; ingeniería observa logs.
**Duración estimada:** 15-20 minutos.
**Objetivo:** confirmar que un usuario puede arrancar un
`operational_case` de tipo `property_optioning` **conversacionalmente**
(chat web y Telegram) sin entrar al formulario de `/operational-cases`.

> Si esta prueba pasa, declaramos Fase A hecha y pasamos a Fase B (assets
> persistentes self-service). Si falla en algún paso, abre un issue con
> el screenshot/log y avisamos antes de arreglar.

---

## Pre-flight (5 min) — antes de teclear nada

1. `npm run dev` debe estar corriendo en el workspace `@agents/web`
   (debería estarlo según tu terminal `1.txt`).
2. Ten abiertas dos pestañas:
   - Pestaña A: `/chat` (chat web logueado con tu usuario).
   - Pestaña B: `/operational-cases` (para auditar que el caso aparece).
3. Telegram: tu bot debe estar vinculado (Ajustes → Telegram debe decir
   "Cuenta de Telegram vinculada"). Si no, vincula primero con `/link`.
4. Verifica que el caso de uso `property_optioning` está activo
   (`/settings/operational-case-types` debe listarlo como Activo, con
   su `intake_schema` definido). Si lo personalizaste, recuerda los
   campos required que pusiste.
5. Abre el terminal de `npm run dev` para ver los logs `[skills]
   active=...` y `[ops-case]` en tiempo real. Vamos a leerlos.

## Bloque 1 — Chat web, ruta feliz (5 min)

**Paso 1.1.** En la pestaña A escribe exactamente:

> necesito opcionar una propiedad

**Esperado:**
- En la terminal aparece una línea
  `[skills] active=property-optioning-coach reason=... channel=web`.
  Si en cambio aparece `active=none` o `active=<otra-skill>`, la skill
  no se enrutó: **detente y reporta**, esto es lo que la auditoría
  preveía como Gap 1.
- El bot responde pidiendo el primer campo del intake (probablemente
  algo como "¿Cuál es la dirección o título de la propiedad?" o el
  primer campo `required` de tu `intake_schema_jsonb`).

**Paso 1.2.** Responde con un valor del primer campo. Ejemplo si te
pide `property_title`:

> Casa de mi mamá en Av. Reforma 123, col. Juárez

**Esperado:**
- El bot pide el **siguiente** campo required (no repite el anterior).
- En logs no debes ver `active=none`; el routing context tiene que
  mantener la skill activa para este turno también. Si lo perdió, es
  Gap 6 de la auditoría.

**Paso 1.3.** Sigue contestando hasta agotar los required del intake.
Sé natural; no des los datos en orden si te incomoda. Ejemplo de campos
típicos: `owner_name`, `owner_phone` o `telegram_chat_id`,
`price_target`. Da lo que tu schema pida.

**Esperado al final:**
- El bot anuncia que creó el caso con un mensaje tipo
  "Listo, registré el caso #XXX, próximo paso: pedir documentos al
  propietario". Si en su lugar pregunta lo mismo de nuevo o tira un
  error, anota el output exacto y los logs.
- En logs verás 1 row nueva en la tabla
  `tool_calls` con `tool_id='operational_case_create'` y `status='executed'`.

**Paso 1.4.** Refresca la pestaña B (`/operational-cases`). El caso
nuevo debe aparecer en la lista:
- Estado: `Activo`.
- Badge nuevo: `Conversacional` (violeta).
- `Paso: Captura inicial`.
- Al abrirlo, el panel `Contexto` debe mostrar los campos que diste y
  `created_from: 'agent_conversation'`.

## Bloque 2 — Chat web, llamada "tentativa" intencional (3 min)

Este bloque valida que el LLM use la respuesta `missing_required_intake_fields`
de la tool para descubrir el schema.

**Paso 2.1.** En la pestaña A (sesión nueva si quieres limpiar contexto):

> opcionar una propiedad

(sin más detalle). **Esperado:** el bot pregunta por los campos
required. No los inventa; los nombres que pregunta deben corresponder
a campos reales de tu `intake_schema_jsonb`. Si pregunta por algo
fuera de tu schema, la skill está alucinando — repórtalo.

**Paso 2.2.** Da datos incompletos a propósito:

> Es una casa en Reforma 123

Esperado: el bot identifica que dirección/título está, pero faltan
otros required y los pide.

## Bloque 3 — Telegram, paridad con web (5 min)

**Paso 3.1.** En el chat con tu bot de Telegram, envía:

> necesito opcionar una propiedad

**Esperado:**
- Logs muestran `[skills] active=property-optioning-coach
  channel=telegram`.
- El bot responde con la primera pregunta del intake.

**Paso 3.2.** Sigue el intake hasta crear el caso. Mismo
comportamiento que el chat web.

**Paso 3.3.** Refresca `/operational-cases`. El caso nuevo debe estar
con badge `Conversacional`. En logs no debe haber errores entre
turnos.

## Bloque 4 — Cancelación / cambio de tema (2 min) (opcional, pero útil)

**Paso 4.1.** Empieza a opcionar:

> necesito opcionar una propiedad

Cuando te pregunte el primer campo, responde:

> mejor olvídalo, dime cuántos leads tuve en abril

**Esperado:** el bot abandona el flujo de opcionar (no crea caso) y
atiende la otra pregunta. Si no, anótalo: significa que la skill no
contempla el abort path (es Gap 4 de la auditoría — no bloqueante).

## Bloque 5 — Continuidad: caso ya creado (2 min)

**Paso 5.1.** Suponiendo que en Bloque 1 creaste el caso #X, escribe
en chat:

> qué falta en el caso de la casa de mi mamá?

**Esperado:** el agente sin caseId explícito en el system prompt,
debería poder hacer una de dos:
1. Asumir continuidad y describir el `current_step` del caso más
   reciente (mejor UX pero exige memoria/lookup que no sabemos si
   está cableada).
2. Pedir explícitamente el `case_id` o un identificador.

Ambos son aceptables para Fase A; sólo anota cuál pasó. Si te pide
case_id, **dáselo** (lo ves en `/operational-cases`) y verifica que
desde ese punto sí carga el caso vía caseId y avanza.

---

## Checklist de criterios para declarar "Fase A pasada"

Marcar todos para cerrar:

- [ ] Bloque 1: ruta feliz en chat web. Caso creado, badge visible.
- [ ] Bloque 2: el bot pregunta sólo por campos del schema real, no
      inventados.
- [ ] Bloque 3: Telegram replica el comportamiento de chat web sin
      diferencias funcionales.
- [ ] Logs muestran `active=property-optioning-coach` para todos los
      turnos en los que el flujo está corriendo, no se pierde en
      turnos de respuesta.
- [ ] `tool_calls.operational_case_create.status='executed'` aparece
      exactamente una vez por caso creado (puede aparecer 1 fallido
      antes si el LLM hizo la llamada speculativa de descubrimiento;
      eso está OK).
- [ ] `/operational-cases` muestra el caso con badge `Conversacional`
      y el detalle muestra `context_jsonb.created_from='agent_conversation'`.

## Qué hacer si algo falla

| Síntoma | Probable causa | Acción |
|---|---|---|
| `active=none` para "necesito opcionar una propiedad" | Selector LLM no enruta. La description quizá necesita más reforzamiento o el modelo del selector está muy conservador. | Reportar texto exacto del mensaje. Es Gap 1 de la auditoría. |
| `active=property-optioning-coach` pero el bot no hace preguntas y responde genérico | La skill no está leyendo bien el contexto. El body de SKILL.md puede no estar viéndose. | Verificar `MAX_SKILL_BODY_TOKENS` y que el resolve haya cargado la skill. |
| El bot crea el caso con `context_jsonb` vacío o con valores erróneos | El LLM no está mapeando bien respuestas a campos. | Reportar la conversación literal y los valores en `context_jsonb`. |
| Cae el dev server con error 500 | Bug nuevo. | Pegar el stack trace en la conversación. |
| Telegram funciona pero chat web no (o viceversa) | Diferencia entre handlers. Probablemente bug en `wire-tool-deps` o en cómo se pasa `channel`. | Reportar cuál canal funciona y cuál no. |

## Cuando termines

Reporta:
1. Qué bloques pasaron y cuáles no.
2. Si algo falló, el texto literal del mensaje fallido y el log
   relevante de la terminal.
3. Tu impresión cualitativa de la experiencia (¿se sintió natural?
   ¿el bot pregunta de más? ¿pierde contexto?).

Basado en eso decidimos:
- Si pasa todo → marcar Fase A completa, ir por Fase B (assets
  persistentes).
- Si falla algún bloque → priorizar el fix antes de seguir.

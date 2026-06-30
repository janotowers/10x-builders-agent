# Script de prueba end-to-end — Intake conversacional durable

**Audiencia:** producto (Janot) ejecuta; ingeniería observa logs.
**Duración estimada:** 15-25 minutos.
**Objetivo:** confirmar que un usuario puede arrancar y continuar un
`operational_case` de tipo `property_optioning` desde Telegram, incluso si
responde tarde o intercala mensajes no relacionados.

Este guion valida el patrón de producción: caso conversacional +
`operational_case_conversation_bindings`, no un fixture sintético de Settings.

---

## Pre-flight (5 min) — antes de teclear nada

1. `npm run dev` debe estar corriendo en el workspace `@agents/web`
   (debería estarlo según tu terminal `1.txt`).
2. Las migraciones `00044_operational_case_conversation_bindings.sql` y
   `00049_external_contact_link_tokens.sql` deben estar aplicadas en la base
   de datos usada por el dev server.
3. Ten abiertas dos pestañas:
   - Pestaña A: `/settings/operational-case-types` en `property_optioning`.
   - Pestaña B: `/operational-cases` (para auditar que el caso aparece).
4. Telegram: tu bot debe estar vinculado (Ajustes → Telegram debe decir
   "Cuenta de Telegram vinculada"). Si no, vincula primero con `/link`.
5. Verifica que el caso de uso `property_optioning` está activo
   (`/settings/operational-case-types` debe listarlo como Activo, con
   su `intake_schema` definido). Si lo personalizaste, recuerda los
   campos required que pusiste.
6. Abre el terminal de `npm run dev` para ver los logs `[skills]
   active=...` y `[ops-case]` en tiempo real. Vamos a leerlos.

## Bloque 1 — Telegram crea caso y binding (5 min)

**Paso 1.1.** En Telegram escribe:

> quiero opcionar una propiedad

**Esperado:**
- El bot pregunta por los campos required faltantes del intake.
- En `/settings/operational-case-types`, **Prueba con agente** deja de decir
  "Sin caso para probar" y muestra Paso 0 / intake conversacional.
- Debe existir un binding activo para ese caso/canal.

**Paso 1.2.** Refresca `/operational-cases`.

**Esperado:**
- Aparece un caso con `created_from='agent_conversation'`.
- `current_step='intake'`.
- `context_jsonb.e2e_controlled` puede seguir vacío hasta el primer tick
  manual en Settings.

## Bloque 2 — Continuación tardía y mensajes no relacionados (5-10 min)

**Paso 2.1.** Sin contestar todavía los datos de la propiedad, escribe una
pregunta no relacionada en Telegram:

> cuántos leads tenemos?

**Esperado:**
- El bot atiende la pregunta general o pide más contexto para esa pregunta.
- No crea otro `operational_case` de `property_optioning`.
- El binding del caso original sigue `awaiting_user`.

**Paso 2.2.** Ahora responde con datos de propiedad, aunque no repitas la
intención inicial. Ejemplo:

> Es un terreno en Valle de Bravo, venta, lote residencial llamado El Encino

**Esperado:**
- El mensaje se asocia al caso pendiente **sin** pedir aclaración «continuar vs
  nueva» cuando sólo hay un caso en `intake` incompleto (precedencia de intake).
- Si hay **varios** casos activos del mismo tipo, el bot puede pedir aclaración
  con tipo de caso, resumen, estado técnico e ID corto.
- Tras confirmar (si aplica), el mensaje se procesa contra el caso original.

## Bloque 3 — Completar intake, documentos y destino (5-10 min)

**Paso 3.1.** Sigue respondiendo los campos required que falten.

**Esperado:**
- El caso conserva el mismo `case_id`.
- Al completar intake, un **solo** mensaje confirma la propiedad, lista
  documentos requeridos, incluye la línea de privacidad y pregunta
  «interno» / «externo».

**Paso 3.2 (opcional — ruta interna).** Responde «interno» y sube uno o más
documentos (individual o álbum). Escribe «listo» cuando termines.

**Esperado:**
- Acuse consolidado (un mensaje por lote, no uno por archivo con la pregunta
  interno/externo repetida).
- El acuse puede incluir pista por tipo de documento cuando el sistema lo
  reconoce.

**Paso 3.3 (opcional — inferencia interna).** En un caso nuevo en
`awaiting_documents` **sin** haber elegido destino, sube un documento desde
Telegram.

**Esperado:**
- El sistema infiere ruta interna y **no** repite «¿interno o externo?» en cada
  archivo.

**Paso 3.4 (opcional — ruta externa Real).** En un caso Real (no E2E lab),
responde «externo» sin contacto verificado.

**Esperado:**
- El bot entrega un enlace `t.me/<bot>?start=ec_…` para reenviar al
  dueño/contacto, más la opción de responder «interno» si cambias de idea.
- Tras abrir el enlace desde otra cuenta/chat de Telegram, el contacto recibe
  confirmación de vinculación y el asesor recibe aviso.

## Bloque 4 — Transiciones manuales en Settings (5 min)

**Paso 4.1.** Cuando el intake quedó completo, el laboratorio deja de pedir
"Completa intake en Telegram" y habilita **Ejecutar una transición con agente**.

**Paso 4.2.** En Settings, da clic en **Ejecutar una transición con agente**.

**Esperado:**
- La transición corre como tick manual de fondo.
- El cron no debe avanzar este recorrido controlado.
- El resumen E2E muestra Paso 0 con actividad conversacional y los pasos
  operativos sólo conforme existan transiciones manuales.

## Bloque 5 — Ambigüedad controlada (opcional, útil)

Si tienes dos casos conversacionales abiertos del mismo tipo, envía un dato
que podría aplicar a ambos.

**Esperado:** el sistema no debe adivinar. Debe pedir aclaración con identidad
de cada candidato: `case_type`, resumen, `status/current_step` e ID corto.

---

## Checklist de criterios para declarar la prueba pasada

Marcar todos para cerrar:

- [ ] Telegram crea/adopta un caso `property_optioning` en `intake`.
- [ ] Se crea un binding conversacional `awaiting_user`.
- [ ] Una pregunta no relacionada no consume ni cancela el binding.
- [ ] Una respuesta tardía con datos de propiedad se asocia al caso correcto sin
      aclaración espuria cuando hay un solo intake incompleto.
- [ ] Post-intake: un mensaje combina confirmación + checklist + interno/externo.
- [ ] Subir docs antes de elegir destino infiere ruta interna (opcional).
- [ ] «Externo» sin contacto entrega deep link de vinculación (opcional, Real).
- [ ] La aclaración multi-caso muestra `case_type`, resumen, estado técnico e ID corto.
- [ ] Settings muestra Paso 0 mientras el intake está incompleto.
- [ ] Al completar required, se habilita la primera transición manual.
- [ ] El cron no avanza el caso controlado; sólo lo hace Prueba con agente.
- [ ] Tras refrescar Settings, el Paso 1 conserva eventos de checklist/recordatorio documental pre-transición (no sólo `document_registered`).
- [ ] La propuesta de precio en Telegram incluye línea **Contraste Avaclick** cuando hay `sale_average_mxn`; **Advertencia** sólo si divergencia ≥30% (`source_conflict`).

## Qué hacer si algo falla

| Síntoma | Probable causa | Acción |
|---|---|---|
| Error de tabla inexistente `operational_case_conversation_bindings` | Falta aplicar migración `00044`. | Aplicar migración en la base del dev server y reiniciar. |
| `active=none` para "quiero opcionar una propiedad" | Selector LLM o capa determinística no enruta. | Reportar texto exacto del mensaje y logs. |
| Se pide aclaración tras enviar datos de intake con un solo caso en intake | El router trataba intención explícita antes que continuación de intake. | Reportar conversación literal; verificar que el fix de precedencia está desplegado. |
| Se crea otro caso al responder datos tardíos | Binding no fue creado/encontrado o resolver con confianza mal calibrada. | Reportar conversación literal y filas de binding. |
| «Externo» responde «elige interno» sin enlace | Falta migración `00049` o contacto ya verificado. | Aplicar migración; revisar `external_contact_jsonb` del caso. |
| Un mensaje no relacionado cancela el caso | El router está tratando todo binding pendiente como continuidad obligatoria. | Reportar mensaje exacto. |
| El bot crea el caso con `context_jsonb` vacío o con valores erróneos | El LLM no está mapeando bien respuestas a campos. | Reportar la conversación literal y los valores en `context_jsonb`. |
| Cae el dev server con error 500 | Bug nuevo. | Pegar el stack trace en la conversación. |
| Settings sigue mostrando "Sin caso para probar" después del mensaje inicial | El caso no se creó, el endpoint no encuentra casos activos, o el caso quedó `paused`. | Refrescar y revisar logs del webhook/endpoint. |

## Cuando termines

Reporta:
1. Qué bloques pasaron y cuáles no.
2. Si algo falló, el texto literal del mensaje fallido y el log
   relevante de la terminal.
3. Tu impresión cualitativa de la experiencia (¿se sintió natural?
   ¿el bot pregunta de más? ¿pierde contexto?).

Basado en eso decidimos si el recorrido E2E puede continuar hacia pasos
operativos manuales o si hay que ajustar routing/bindings antes.

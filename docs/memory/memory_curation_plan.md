---
name: Memory Curation & Extractor Hardening
overview: "Refinar la memoria de largo plazo en dos frentes complementarios: (1) endurecer el extractor para que NO grabe datos transaccionales de negocio (leads, propiedades, citas, mensajes) ni inputs de tarea como hechos del usuario; (2) habilitar curación de los hechos ya guardados desde la UI y desde el agente, con TTL/decay opcional siempre confirmado por el usuario (HITL). No reemplaza `long_term_memory_plan.md`; lo complementa."
todos:
  - id: extractor-hardening
    content: Añadir reglas duras al EXTRACTION_SYSTEM_PROMPT (memory_flush.ts) para descartar datos operacionales del CRM (leads, propiedades, mensajes, citas, deals) y artefactos de tarea ("redacta WhatsApp para X"). Cubrir con selftest.
    status: completed
  - id: extractor-routing-veto
    content: Añadir veto opcional por skill activo — si el turno corrió bajo skills marcados como "ephemeral_business_data" (lead-follow-up-draft, compose-message, client-meeting-prep, etc.), el extractor NO procesa ese tramo. Implementar como flag a nivel SKILL.md (ej. `memory_extraction: ephemeral`).
    status: completed
  - id: memory-list-ui
    content: Vista "Mis recuerdos" en apps/web — listar memorias del usuario (type, content, created_at, retrieval_count), filtros por tipo, búsqueda por substring, acciones soft-delete (archive) y hard-delete con confirmación.
    status: completed
  - id: memory-list-api
    content: Endpoints GET /api/memories (lista paginada del user actual) y POST /api/memories/:id/archive y DELETE /api/memories/:id en apps/web. Auth obligatoria (sesión Supabase).
    status: completed
  - id: memory-curate-skill
    content: Skill `memory-curate` (global) con tools `list_user_memories`, `search_user_memories`, `archive_user_memory`, `delete_user_memory` (writes con HITL). Incluye guards en graph, modal HITL con texto del recuerdo, y skill doc con recap sin reintentos duplicados.
    status: completed
  - id: memory-ttl-job
    content: (Opcional, fase posterior) Job/cron que detecta "recuerdos sospechosos" (retrieval_count=0 tras N días, o coincidencia con regex de datos operacionales). NO borra automáticamente — encola un evento que el agente surface al usuario en el siguiente turno relevante para confirmar HITL.
    status: pending
  - id: memory-archive-column
    content: Migración SQL — agregar `archived_at TIMESTAMPTZ` a la tabla `memories` y filtrar por `archived_at IS NULL` en searchMemories. Esto habilita soft-delete reversible antes del hard-delete.
    status: completed
isProject: false
---

## Estado implementación (2026-05)

**En código (shipped):**

- **Capa 2 (curación):** migración [`packages/db/supabase/migrations/00011_memories_archived.sql`](../../packages/db/supabase/migrations/00011_memories_archived.sql), queries en `@agents/db`, APIs en [`apps/web/src/app/api/memories/`](../../apps/web/src/app/api/memories/), página [`/memory`](../../apps/web/src/app/memory/page.tsx) con filtros, orden por fecha de creación o de archivo (`archived_at`) y ascendente/descendente.
- **Skill y tools:** [`skills/global/memory-curate/SKILL.md`](../../skills/global/memory-curate/SKILL.md) con `list_user_memories`, `search_user_memories`, `archive_user_memory`, `delete_user_memory`; HITL enriquecido en [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) (contenido del recuerdo + UUID en el modal); `findExistingPendingToolCall` deduplica por args.
- **Capa 1 (prompt):** reglas nuevas en [`packages/agent/src/memory_flush.ts`](../../packages/agent/src/memory_flush.ts) (`EXTRACTION_SYSTEM_PROMPT`); selftest [`packages/agent/src/memory_flush.selftest.ts`](../../packages/agent/src/memory_flush.selftest.ts).
- **Capa 1 (veto por skill):** frontmatter `memory_extraction: ephemeral` en skills transaccionales (`company-data`, `lead-follow-up-draft`, `compose-message`, `client-meeting-prep`); `runAgent` persiste `activeSkill`/`memoryExtraction` en `agent_messages.structured_payload`; [`memory_flush.ts`](../../packages/agent/src/memory_flush.ts) filtra esos mensajes antes de llamar a Haiku.
- **Infra:** Session Pooler para LangGraph checkpointer — [`docs/setup/supabase_pooler.md`](../setup/supabase_pooler.md) y [`packages/agent/src/checkpointer.ts`](../../packages/agent/src/checkpointer.ts) (timeouts, diagnósticos).

**Pendiente u opcional (roadmap):**

- **Capa 3 — TTL / cola de revisión con HITL:** fase posterior del propio plan (§ Capa 3). Se mantiene pendiente deliberadamente hasta tener más volumen real de memorias; no debe borrar ni archivar nada sin aprobación HITL del usuario.
- **Producto:** archivar varias memorias en **un solo** HITL — explícitamente pospuesto; el flujo actual es un HITL por recuerdo.

**Operaciones:** aplicar la migración en Supabase producción y usar `DATABASE_URL` del Session Pooler en el entorno desplegado (véase `docs/setup/supabase_pooler.md`).

---

# Plan — Curación de memoria larga + endurecimiento del extractor

Este plan complementa `docs/memory/long_term_memory_plan.md`. El plan original
construyó la **maquinaria** (extracción, inyección, watermark, dedup); este
documento aborda dos problemas observados en producción tras esa
implementación:

1. **Falsos positivos del extractor**: Haiku está guardando como "hechos del
   usuario" información operacional del CRM (nombres de leads, teléfonos
   de leads, propiedades específicas) que vino al hilo de una tarea
   transaccional, no como una preferencia o relación duradera del usuario.
   Eso luego se inyecta en turnos posteriores y el modelo lo usa como si
   fuera contexto autoritativo, generando respuestas confidentes pero
   incorrectas (ej. saludar al usuario por el nombre de un lead).
2. **No hay forma de limpiar lo ya guardado**: ni desde la UI ni desde
   el propio agente. La única opción es modificar Supabase manualmente, lo
   que rompe la promesa de auto-servicio.

## Diagnóstico (sesión 2026-05-02)

Con la skill `lead-follow-up-draft` recién activada, el extractor guardó
como `semantic` cosas como:

- `"Su nombre es Julieta Evelia"`
- `"El número de teléfono de Julieta Evelia es 5216688255676"`

Estas afirmaciones provienen de mensajes `[user]` reales en el transcript
(el usuario sí escribió esas frases), por lo que la regla 1 del prompt
actual (`Solo atribuye al USUARIO cosas que el USUARIO dijo o pidió
directamente`) se cumple técnicamente. Pero el contexto es: el usuario
estaba dándole **input a una tarea transaccional**, no compartiendo
información estable sobre su vida. El extractor no tiene cómo distinguir
ese matiz hoy.

Cuando ese hecho vuelve inyectado en un turno futuro como
`(semantic) Su nombre es Julieta Evelia`, el modelo lo lee como "el
usuario se llama Julieta Evelia" y lo usa para "personalizar". Daño
clásico de memoria que se confunde entre **fact about the user** y
**fact about an entity the user mentioned**.

## Estrategia

Tres capas, en orden de implementación:

1. **Prevenir** lo nuevo (endurecer extractor).
2. **Curar** lo viejo (UI + skill `memory-curate`).
3. **Mantener** a futuro (TTL/decay con HITL — fase posterior, opcional).

Cada capa es independiente; las tres no son condición para shippear las
otras. La capa 1 es la prioridad porque corta el flujo de basura.

---

## Capa 1 — Endurecer el extractor

### Reglas duras a añadir al `EXTRACTION_SYSTEM_PROMPT`

Insertar después de la regla 4 actual y renumerar:

> **Regla 5 — Datos operacionales de negocio**: NO extraigas información
> sobre **terceros del flujo de trabajo del usuario** que aparezca como
> input a una tarea transaccional. Específicamente:
>
> - Nombres, teléfonos, emails o IDs de **leads, prospectos, clientes,
>   asistentes a citas, contrapartes de un deal**.
> - Direcciones, precios, IDs o atributos de **propiedades, inventario,
>   catálogo, eventos**.
> - Contenido de **mensajes que el usuario está componiendo o pidiendo
>   redactar** (WhatsApps, emails, drafts, briefs).
> - **Estados de pipeline** (etapas, fechas de seguimiento, montos por
>   cerrar).
>
> Estas entidades viven en sistemas externos (CRM, BigQuery, calendario)
> y el agente las consulta con tools cuando las necesita. Guardarlas en
> memoria larga las congela en el tiempo y contamina el contexto. La
> EXCEPCIÓN única son contactos personales estables del usuario (familia,
> amistades, su contador, su médico) compartidos deliberadamente, no como
> input a una tarea operativa.
>
> **Test rápido**: si la afirmación tiene la forma `<entidad de negocio>
> tiene <atributo>` o `el <lead/cliente/propiedad> X <verbo>`, NO la
> extraigas.

> **Regla 6 — Inputs de tarea**: NO extraigas afirmaciones que solo
> existen porque el agente le pidió un dato al usuario para completar
> una herramienta o draft (ej. "el nombre es X", "el teléfono es Y",
> "la fecha de la cita es Z"). Esos son **parámetros de un turno**, no
> hechos durables sobre el usuario. Heurística: si el `[assistant]`
> inmediato anterior pidió ese dato y el `[user]` solo respondió con el
> valor, NO lo extraigas.

(Las reglas 5–7 actuales pasan a ser 7–9.)

Adicionalmente, fortalecer el ejemplo positivo del prompt para que
muestre claramente **qué SÍ extraer** y **qué NO** con casos del dominio
inmobiliario:

```
Ejemplos:
SÍ: "El usuario es asesor inmobiliario en Mazatlán" (rol durable)
SÍ: "Prefiere mensajes de WhatsApp en tono amigable y firma 'Saludos, Juan'"
SÍ: "Su contadora se llama Lucía Pérez, contacto +52 33 1234 5678"
NO: "El lead Julieta Evelia tiene teléfono 521..." (dato operacional del CRM)
NO: "La propiedad de la calle Reforma 123 está en venta" (dato del inventario)
NO: "Quiere redactar un WhatsApp para Pedro" (intención de tarea, no preferencia)
NO: "El nombre del lead es X" (input a una tarea)
```

### Veto a nivel skill (refuerzo defensivo)

Algunas skills son por naturaleza **transaccionales**: `company-data`,
`lead-follow-up-draft`, `compose-message`, `client-meeting-prep` (y otras
podrían sumarse en el futuro). Aun con un prompt mejorado, conviene no
mandar esos transcripts al extractor.

Implementación vigente:

1. Añadir un campo opcional al frontmatter del SKILL.md:

   ```yaml
   memory_extraction: ephemeral   # o "default" (implícito si se omite)
   ```

2. Persistir por turno qué skill estuvo activa en
   `agent_messages.structured_payload` (`activeSkill` +
   `memoryExtraction`), sin migración de columnas.
3. En `memory_flush`, antes de armar el transcript, **filtrar** los
   mensajes cuyo `structured_payload.memoryExtraction` esté marcado como
   `ephemeral`.
   Si tras el filtro el set queda por debajo de `MEMORY_FLUSH_MIN_NEW_MESSAGES`,
   skip con `reason: "ephemeral_skills_only"`.

Beneficio: aunque Haiku falle, ni siquiera ve el material problemático.
Coste: un campo nuevo en SKILL.md y metadata en `structured_payload`; no
requiere migración.

### Selftests

Añadir `packages/agent/src/memory_flush.selftest.ts` (o ampliar el
existente) con casos:

- Transcript con skill `lead-follow-up-draft` y respuestas del usuario
  con nombre/teléfono de un lead → `extracted === 0` (con veto activo) o
  `0` items que coincidan con datos del lead (con solo prompt).
- Transcript con preferencia genuina ("siempre prefiero responder en
  bullets") → al menos 1 item de tipo `procedural`.
- Transcript con familia ("mi hermana Ana cumple años el 15 de marzo") →
  1 item `semantic`.

---

## Capa 2 — Curación

Dos vías paralelas, ambas valiosas:

### a) UI — "Mis recuerdos"

Una página en `apps/web` (ej. `/settings/memory` o `/memory`) que liste
los recuerdos del usuario actual.

**Schema mínimo de la vista**:

| Campo | Origen |
|---|---|
| Tipo | `memories.type` |
| Contenido | `memories.content` |
| Creado | `memories.created_at` |
| Veces recuperado | `memories.retrieval_count` |
| Última vez recuperado | `memories.last_retrieved_at` (si existe; si no, agregar) |
| Estado | derivado de `archived_at IS NULL` |

**Acciones**:

- **Archivar** (soft-delete reversible): UPDATE `archived_at = NOW()`.
  El recuerdo deja de aparecer en `searchMemories` (filtro
  `archived_at IS NULL`) pero queda visible en una pestaña "Archivados"
  con opción de restaurar.
- **Eliminar definitivamente**: DELETE con confirmación modal.
- **Buscar / filtrar**: por substring, por tipo, por rango de fecha.

**Endpoints**:

- `GET /api/memories?archived=false&type=&q=&limit=50&offset=0`
- `POST /api/memories/:id/archive`
- `POST /api/memories/:id/restore`
- `DELETE /api/memories/:id`

Auth: sesión Supabase obligatoria; `WHERE user_id = auth.uid()` en cada
query (RLS ya lo refuerza).

### b) Skill `memory-curate` — gestión conversacional

Permite al usuario gestionar recuerdos sin salir del chat. Skill global
que se activa con frases como:

- "qué recuerdas de mí"
- "olvida lo de Julieta Evelia"
- "borra los recuerdos de tipo episodic de hace más de 3 meses"
- "actualiza el recuerdo sobre mi negocio"

**Tools nuevas** (a registrar en `packages/agent/src/tools/`):

| Tool | Tipo | HITL |
|---|---|---|
| `list_user_memories` | read | no |
| `search_user_memories` | read | no |
| `archive_user_memory` | write | sí (mostrar el contenido antes de archivar) |
| `delete_user_memory` | write | sí (confirmación textual del usuario) |
| `update_user_memory` | write | sí |

**HITL obligatorio para escritura**: el agente NUNCA borra/archiva un
recuerdo sin que el usuario confirme en el turno actual. El patrón
establecido en `docs/tools-design/hitl.md` se reutiliza:
`tool_call → confirmation interrupt → user yes/no → execute`.

Ejemplo de flujo:

```
Usuario: olvida lo del lead Julieta Evelia
Agente: Encontré 2 recuerdos relacionados:
        1. (semantic) Su nombre es Julieta Evelia
        2. (semantic) El número de teléfono de Julieta Evelia es 521...
        ¿Borro los dos? (sí / no / solo el primero)
Usuario: sí
Agente: ✅ Borré los 2 recuerdos.
```

**Notas de seguridad**:

- La skill solo opera sobre `WHERE user_id = current_user_id`. RLS lo
  refuerza, pero la tool valida explícitamente.
- Los IDs de memoria mostrados al usuario son los reales (UUIDs cortos
  o slugs); no se exponen embeddings.
- Las acciones se loguean en una tabla `memory_audit_log` (id, user_id,
  memory_id, action, performed_at) para que el usuario pueda ver el
  historial si pregunta.

### Migración necesaria para a) y b)

```sql
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_memories_user_active
  ON memories (user_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  memory_id UUID,
  action TEXT NOT NULL CHECK (action IN ('archive','restore','delete','update')),
  details JSONB,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- RLS policies análogas a la tabla memories.
```

Y actualizar:

- `searchMemories`: añadir `AND archived_at IS NULL`.
- `incrementRetrievalCount`: setear también `last_retrieved_at = NOW()`.

---

## Capa 3 — TTL / decay con HITL (fase posterior, opcional)

**Decisión del usuario (2026-05-02)**: cualquier limpieza automática
debe ser confirmada por el usuario antes de aplicarse. NO autodelete
silencioso.

### Diseño propuesto

Un job (Supabase Edge Function + `pg_cron` semanal, o cron de Vercel
si preferimos centralizar) escanea `memories` y marca como
`suggested_for_review` aquellos que cumplan **al menos** una de:

- `retrieval_count = 0 AND created_at < NOW() - INTERVAL '90 days'`.
- Coincidencia con regex de datos transaccionales (teléfonos largos,
  nombres seguidos de IDs numéricos, frases de la forma "el nombre del
  lead es ...").
- `last_retrieved_at < NOW() - INTERVAL '180 days'` AND
  `retrieval_count < 2`.

El job NO borra. Inserta filas en `memory_review_queue` (id, memory_id,
reason, created_at). El agente, en un turno futuro relevante (cuando
el usuario hable casualmente o haga una pausa), surface la cola con un
mensaje del estilo:

> Tengo 3 recuerdos sobre ti que llevan tiempo sin usarse. ¿Quieres
> revisarlos?

Si el usuario acepta, entra al flujo del skill `memory-curate` con el
batch precargado.

Si el usuario ignora la cola N veces, los items pasan a un estado
`dormant` y dejan de surgir hasta que el usuario las invoque
explícitamente desde la UI.

**Esto se implementa después de Capas 1 y 2** y se puede incluso evaluar
si vale la pena dado el volumen real de memorias.

---

## Orden recomendado de implementación

1. **Capa 1, prompt-only** (1 PR pequeño, 1–2 h): editar
   `EXTRACTION_SYSTEM_PROMPT` con las reglas 5 y 6, agregar selftests.
   Esto corta el flujo nuevo.
2. **Capa 2, migración + UI básica** (1 PR mediano, 1–2 días):
   migración `archived_at`, endpoints REST, página `/memory` mínima
   con listar+archivar+borrar.
3. **Capa 1, veto por skill** (completado): filtrar en `memory_flush` los
   turnos marcados como `memory_extraction: ephemeral`.
4. **Capa 2, skill `memory-curate`** (1 PR mediano, 1–2 días):
   tools + skill + HITL.
5. **Capa 3, TTL job** (evaluar después de N semanas con Capa 2 viva).

## Métricas de éxito

- Tras Capa 1: 0 recuerdos creados en una semana de uso normal del
  skill `lead-follow-up-draft` que contengan tokens del CRM (verificable
  con un grep/regex sobre `memories.content`).
- Tras Capa 2: el usuario puede listar y borrar cualquier recuerdo en
  ≤ 30 segundos sin tocar Supabase manualmente.
- Tras Capa 3 (si se implementa): 100% de las eliminaciones automáticas
  son confirmadas por el usuario; 0 falsos positivos borrados sin su
  consentimiento.

## Cosas que NO hace este plan

- No reemplaza la maquinaria de inyección/extracción del plan original;
  la complementa.
- No introduce un re-ranker LLM en la inyección (potencial Capa 4
  futura, fuera de alcance).
- No toca el flujo de `compaction_node` ni el `agent_node`.
- No cambia el modelo de embeddings ni la dimensión.

# Proveedores de modelo (fachada multi-proveedor)

## Roles actuales (OpenRouter)

Inventario canónico. **Defaults y lectura de env** viven en [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts). Las factories del loop LangGraph también; visión/listing/clasificador importan las mismas constantes en su punto de uso.

| Rol | Env | Default | Dónde se usa |
| --- | --- | --- | --- |
| Agente principal | `MAIN_AGENT_MODEL_ID` | `openai/gpt-5.4-mini` | `createChatModel` → web, telegram, cron, case_runner |
| Heartbeat | `HEARTBEAT_MODEL_ID` (+ `HEARTBEAT_MAX_TOKENS`) | hereda main si se omite | `graph.ts` vía `resolveHeartbeatModelId()` |
| Compaction / memory flush | `COMPACTION_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createCompactionModel` |
| Skill selector | `SKILL_SELECTOR_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createSkillSelectorModel` |
| Business Brain reviewer | `BUSINESS_BRAIN_REVIEWER_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createBusinessBrainReviewerModel` |
| Clasificador conversacional de casos (+ 2ª opinión HITL `unclear`) | `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID` | `openai/gpt-5.4-mini` | `apps/web/.../operational-conversation-classifier.ts`, `pending-decision-unclear-classifier.ts` |
| Vision / fotos | `IMAGE_VISION_MODEL_ID` | `openai/gpt-4.1-mini` | `packages/agent/.../realestate-adapters.ts` |
| Copy de listing | `LISTING_COPY_MODEL_ID` | `openai/gpt-4.1-mini` | `packages/agent/.../realestate-adapters.ts` |
| Embeddings memoria | `MEMORY_EMBEDDING_MODEL` | `google/gemini-embedding-001` | `packages/agent/src/embeddings.ts` |

Tope global de salida: `OPENROUTER_MAX_TOKENS` (default código 2048).

## Política por tarea del Studio

Studio no usa un único “modelo de creación”. La resolución tipada vive en
`resolveStudioModelId(task, env, tier)` y separa costo, juicio y metering:

- `authoring_router`, `authoring_discovery`, `case_workflow_compiler`,
  `durable_task_compiler` y `reusable_skill_compiler` usan
  `openai/gpt-5.4-mini` como primario;
- discovery y los compiladores pueden consumir una sola completion de
  escalación (`WORKFLOW_AUTHORING_ESCALATION_MODEL_ID`, default
  `anthropic/claude-opus-5`) únicamente después de un fallo de contrato o gate
  que el primario no pueda resolver;
- `skill_repair`, `operational_judge` y el rol reservado
  `capability_coder` usan un modelo frontier por defecto;
- reintentos de transporte 429/5xx/red no consumen el presupuesto semántico de
  completions; el botón manual aparece solo después de agotar la recuperación
  automática;
- cada tarea usa un `model_role` `studio_*` distinto y metadata `tier`, para no
  mezclar router, discovery, compilación, reparación, juez y coding en el costo
  histórico de `workflow_compiler`.

La configuración recomendada y todas las cadenas de fallback están comentadas
en `apps/web/.env.example`. Los call sites no deben leer defaults de proveedor
por su cuenta.

### Contrato reservado de capability coder

`capability_coder` define política y atribución, pero **no activa hoy generación
de código desde Studio**. Cuando se implemente, solo podrá abrirse después de
confirmar que el catálogo no contiene una capacidad suficiente y deberá recibir
un contrato confirmado de inputs, outputs, permisos, side effects y pruebas.
Su salida será un borrador versionado (patch/manifest/tests/riesgos), nunca un
deploy, publicación, secreto, migración aplicada ni write externo. Requerirá
sandbox, allowlist de archivos/APIs, validación determinista, revisión humana y
aprobación explícita antes de integrar. El modelo por defecto es Opus mediante
`WORKFLOW_CAPABILITY_CODER_MODEL_ID`; el costo se atribuye a
`studio_capability_coder`.

## Estado (multi-proveedor)

| Aspecto | Estado |
| ------- | ------ |
| Documento de diseño | Este archivo (versionado en el repo). |
| Roles OpenRouter actuales | **Implementados** (tabla arriba). |
| Multi-proveedor (Gemini directo) | **Pendiente.** Hoy solo OpenRouter vía `ChatOpenAI` + `baseURL` OpenRouter. |

Evita confundir este documento con el comportamiento actual del binario: las variables `MODEL_PROVIDER_*` y la integración directa con Gemini **aún no existen** en el código hasta que se implemente el plan correspondiente.

## Objetivo

Permitir elegir entre **OpenRouter** y **Google** (Gemini vía **AI Studio** con API key, o **Vertex AI** en GCP) sin esparcir lógica de proveedor por el grafo LangGraph, los adapters de tools ni el checkpointer.

- **Mismo contrato:** `runAgent` sigue construyendo mensajes, tools y HITL igual; solo cambia la instancia de `BaseChatModel` detrás de la fachada.
- **Canales:** separar configuración para chat **interactivo** (Web / Telegram), ejecuciones **cron** (tareas programadas) y **heartbeat** proactivo, alineado con la temperatura/modelo ya distinta por canal en [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts).

## Por qué OpenRouter y Google directo son distintos

- **OpenRouter** factura contra **tu saldo en OpenRouter**. Actúa como agregador: eliges modelos por slug (p. ej. `openai/gpt-4o-mini`) y una sola API tipo OpenAI.
- **Google (AI Studio / Vertex)** factura contra **Google** (API key de AI Studio o proyecto GCP + Vertex). Tus créditos o cuotas de **Google Cloud no se aplican automáticamente** si solo usas OpenRouter: pagas el flujo del agregador salvo configuración explícita del producto (BYOK u opciones similares, si existieran).

Por eso tiene sentido soportar **Google directo** además de OpenRouter cuando el presupuesto útil está en GCP.

## Fachada: un solo punto de construcción del modelo

La idea es concentrar la creación del LLM en **`createChatModel`** (y helpers internos en el mismo módulo), de modo que [`graph.ts`](../../packages/agent/src/graph.ts) solo pida:

- `channel`: `interactive` | `cron` | `heartbeat` (derivado explícitamente de `input.channel`; `autoApproveTools` solo conserva compatibilidad para cron),
- `temperature`: ya resuelto hoy con `DEFAULT_INTERACTIVE_TEMPERATURE` / `DEFAULT_CRON_TEMPERATURE` / `DEFAULT_HEARTBEAT_TEMPERATURE`.

El grafo sigue haciendo `model.bindTools(lcTools)` (y, si hay fallback, la composición con `withFallbacks` **después** de enlazar tools en **cada** modelo candidato, para que tool-calling funcione en primario y secundario).

```mermaid
flowchart LR
  runAgent["runAgent"] --> facade["createChatModel / buildModelPair"]
  facade --> openrouter["OpenRouter ChatOpenAI"]
  facade --> google["Gemini AI Studio o Vertex"]
  openrouter --> bound["bindTools"]
  google --> bound
  bound --> optional["withFallbacks opcional"]
  optional --> graph["nodo agent del grafo"]
```

## Variables de entorno (resumen previsto)

Nombres orientativos; la lista definitiva vivirá en `apps/web/.env.example` cuando exista la implementación.

| Variable | Rol |
| -------- | --- |
| `MODEL_PROVIDER_INTERACTIVE` | `openrouter` \| `google` (default: `openrouter`). |
| `MODEL_PROVIDER_CRON` | Igual, para el runner de tareas programadas. |
| `MODEL_PROVIDER_HEARTBEAT` | Igual, para el runner proactivo de Heartbeat. |
| `MODEL_INTERACTIVE` / `MODEL_CRON` / `MODEL_HEARTBEAT` | Nombre del modelo según proveedor (p. ej. `openai/gpt-4o-mini` en OpenRouter; `gemini-2.5-flash` u otro id en Google). |
| `MAX_TOKENS_INTERACTIVE` / `MAX_TOKENS_CRON` / `MAX_TOKENS_HEARTBEAT` | Tope de salida por canal; hoy existen `OPENROUTER_MAX_TOKENS` como fallback único y `HEARTBEAT_MAX_TOKENS` para Heartbeat. |
| `GOOGLE_AUTH_MODE` | `aistudio` \| `vertex`. |
| `GOOGLE_API_KEY` | AI Studio (cuando `GOOGLE_AUTH_MODE=aistudio`). |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` | Vertex; más credenciales ADC (`GOOGLE_APPLICATION_CREDENTIALS` o `gcloud auth application-default login`). |
| `MODEL_FALLBACK_INTERACTIVE` / `MODEL_FALLBACK_CRON` / `MODEL_FALLBACK_HEARTBEAT` | Proveedor alternativo opcional si el primario falla de forma persistente (`none` = sin fallback). |

## Fallback entre proveedores

Si se configura un proveedor de respaldo por canal, la composición prevista usa **`withFallbacks`** de LangChain **después** de `bindTools` en ambos modelos, de modo que un error recuperable o agotamiento en el primario delegue en el segundo sin duplicar lógica en nodos del grafo.

## Riesgos y comprobaciones

- **Tool-calling:** distintos proveedores pueden comportarse distinto con el mismo esquema de tools; conviene probar HITL, `bash`, calendario y `schedule_task` / `manage_scheduled_tasks` al cambiar de proveedor.
- **Vertex:** región, API habilitada en el proyecto, permisos IAM del service account y cuotas.
- **Coste y límites:** no asumir que el fallback es gratis; acotar reintentos y registrar errores como ya hacen los runners de tareas programadas y Heartbeat.

## Plan de implementación (checklist técnico)

El desglose de tareas (dependencias npm, refactor de `model.ts` / `graph.ts`, clasificadores de error en el cron, etc.) se mantiene en un **plan local de Cursor**, no versionado en este repo, por convención del IDE. Busca en la máquina de desarrollo:

- `.cursor/plans/multi-provider_model_facade_*.plan.md`

(o el nombre actual del plan si fue renombrado). Ese archivo es complementario: **este** `.md` explica la idea; **aquél** lista pasos concretos de código.

Archivos previstos a tocar en la implementación: principalmente [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts), [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) y, de forma menor, los runners [`apps/web/src/app/api/cron/scheduled-tasks/route.ts`](../../apps/web/src/app/api/cron/scheduled-tasks/route.ts) y [`apps/web/src/app/api/cron/heartbeat/route.ts`](../../apps/web/src/app/api/cron/heartbeat/route.ts) para alinear detección de errores persistentes con respuestas de Google.

## Catálogo de precios (metering / Slice 0.4.1)

El ledger `ai_usage_events` prefiere el costo facturado de OpenRouter (`usage.cost` → `reported_cost_micro_usd`). El catálogo local solo aporta **estimados de referencia** (`estimated_cost_micro_usd`) y se versiona de forma inmutable:

| Pieza | Ubicación |
| --- | --- |
| Snapshots | [`packages/agent/src/usage/catalogs/`](../../packages/agent/src/usage/catalogs/) — un JSON por `pricing_version` |
| Loader | [`packages/agent/src/usage/model-price-catalog.ts`](../../packages/agent/src/usage/model-price-catalog.ts) |
| Generar versión nueva | `npm run generate:model-price-catalog -- --version YYYY-MM-DD.N` |
| Validar (CI / prebuild) | `npm run validate:model-price-catalog` |
| Drift vs OpenRouter (manual) | `npm run check:model-price-catalog-drift` |

**Reglas:**

1. Nunca editar un snapshot existente. Cualquier cambio de precio = archivo nuevo + import activo actualizado en `model-price-catalog.ts`.
2. Generar precios desde las APIs públicas de OpenRouter (`/api/v1/models` + `/api/v1/embeddings/models`), no a mano.
3. El costo operativo del dashboard es **contabilizado** = `reported ?? estimated ?? 0` por evento; reportado y estimado pueden coexistir en la misma fila para comparación, pero no se suman.
4. Filas históricas con `pricing_version = '2026-07-29.1'` se reproducen contra ese snapshot aunque el catálogo activo sea más nuevo.

Dashboard interno: `/settings/ai-usage` (admin Ungga; sidebar **Configuración → Uso de IA**). Exploración interactiva: filtros client-side, ventana `?days=7|30|90`, rollups por proveedor/función/ejecución/caso. Flag: `AI_USAGE_METERING_ENABLED=true`.

## Relación con otros documentos

- Arquitectura general: [`docs/architecture.md`](../architecture.md) — tabla de stack y sección de modelo.
- Plan de producto: [`docs/plan.md`](../plan.md) — enlace al diseño multi-proveedor.

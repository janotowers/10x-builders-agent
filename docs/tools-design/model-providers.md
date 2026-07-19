# Proveedores de modelo (fachada multi-proveedor)

## Roles actuales (OpenRouter)

Inventario canónico. **Defaults y lectura de env** viven en [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts). Las factories del loop LangGraph también; visión/listing/clasificador importan las mismas constantes en su punto de uso.

| Rol | Env | Default | Dónde se usa |
| --- | --- | --- | --- |
| Agente principal | `MAIN_AGENT_MODEL_ID` | `openai/gpt-4o-mini` | `createChatModel` → web, telegram, cron, case_runner |
| Heartbeat | `HEARTBEAT_MODEL_ID` (+ `HEARTBEAT_MAX_TOKENS`) | hereda main si se omite | `graph.ts` vía `resolveHeartbeatModelId()` |
| Compaction / memory flush | `COMPACTION_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createCompactionModel` |
| Skill selector | `SKILL_SELECTOR_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createSkillSelectorModel` |
| Business Brain reviewer | `BUSINESS_BRAIN_REVIEWER_MODEL_ID` | `anthropic/claude-haiku-4.5` | `createBusinessBrainReviewerModel` |
| Clasificador conversacional de casos | `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID` | mismo que main | `apps/web/.../operational-conversation-classifier.ts` |
| Vision / fotos | `IMAGE_VISION_MODEL_ID` | `openai/gpt-4.1-mini` | `packages/agent/.../realestate-adapters.ts` |
| Copy de listing | `LISTING_COPY_MODEL_ID` | `openai/gpt-4.1-mini` | `packages/agent/.../realestate-adapters.ts` |
| Embeddings memoria | `MEMORY_EMBEDDING_MODEL` | `google/gemini-embedding-001` | `packages/agent/src/embeddings.ts` |

Tope global de salida: `OPENROUTER_MAX_TOKENS` (default código 2048).

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

## Relación con otros documentos

- Arquitectura general: [`docs/architecture.md`](../architecture.md) — tabla de stack y sección de modelo.
- Plan de producto: [`docs/plan.md`](../plan.md) — enlace al diseño multi-proveedor.

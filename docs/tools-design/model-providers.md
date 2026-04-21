# Proveedores de modelo (fachada multi-proveedor)

## Estado

| Aspecto | Estado |
| ------- | ------ |
| Documento de diseño | Este archivo (versionado en el repo). |
| Implementación en código | **Pendiente.** Hoy el agente usa solo OpenRouter vía `ChatOpenAI` con `baseURL` de OpenRouter en [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts) (`openai/gpt-4o-mini` por defecto). |

Evita confundir este documento con el comportamiento actual del binario: las variables `MODEL_PROVIDER_*` y la integración directa con Gemini **aún no existen** en el código hasta que se implemente el plan correspondiente.

## Objetivo

Permitir elegir entre **OpenRouter** y **Google** (Gemini vía **AI Studio** con API key, o **Vertex AI** en GCP) sin esparcir lógica de proveedor por el grafo LangGraph, los adapters de tools ni el checkpointer.

- **Mismo contrato:** `runAgent` sigue construyendo mensajes, tools y HITL igual; solo cambia la instancia de `BaseChatModel` detrás de la fachada.
- **Canales:** separar configuración para chat **interactivo** (Web / Telegram) y para ejecuciones **cron** (tareas programadas), alineado con la temperatura ya distinta por contexto en [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) (`autoApproveTools`).

## Por qué OpenRouter y Google directo son distintos

- **OpenRouter** factura contra **tu saldo en OpenRouter**. Actúa como agregador: eliges modelos por slug (p. ej. `openai/gpt-4o-mini`) y una sola API tipo OpenAI.
- **Google (AI Studio / Vertex)** factura contra **Google** (API key de AI Studio o proyecto GCP + Vertex). Tus créditos o cuotas de **Google Cloud no se aplican automáticamente** si solo usas OpenRouter: pagas el flujo del agregador salvo configuración explícita del producto (BYOK u opciones similares, si existieran).

Por eso tiene sentido soportar **Google directo** además de OpenRouter cuando el presupuesto útil está en GCP.

## Fachada: un solo punto de construcción del modelo

La idea es concentrar la creación del LLM en **`createChatModel`** (y helpers internos en el mismo módulo), de modo que [`graph.ts`](../../packages/agent/src/graph.ts) solo pida:

- `channel`: `interactive` | `cron` (derivado de `input.autoApproveTools`),
- `temperature`: ya resuelto hoy con `DEFAULT_INTERACTIVE_TEMPERATURE` / `DEFAULT_CRON_TEMPERATURE`.

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
| `MODEL_INTERACTIVE` / `MODEL_CRON` | Nombre del modelo según proveedor (p. ej. `openai/gpt-4o-mini` en OpenRouter; `gemini-2.5-flash` u otro id en Google). |
| `MAX_TOKENS_INTERACTIVE` / `MAX_TOKENS_CRON` | Tope de salida por canal; hoy existe `OPENROUTER_MAX_TOKENS` como fallback único. |
| `GOOGLE_AUTH_MODE` | `aistudio` \| `vertex`. |
| `GOOGLE_API_KEY` | AI Studio (cuando `GOOGLE_AUTH_MODE=aistudio`). |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` | Vertex; más credenciales ADC (`GOOGLE_APPLICATION_CREDENTIALS` o `gcloud auth application-default login`). |
| `MODEL_FALLBACK_INTERACTIVE` / `MODEL_FALLBACK_CRON` | Proveedor alternativo opcional si el primario falla de forma persistente (`none` = sin fallback). |

## Fallback entre proveedores

Si se configura un proveedor de respaldo por canal, la composición prevista usa **`withFallbacks`** de LangChain **después** de `bindTools` en ambos modelos, de modo que un error recuperable o agotamiento en el primario delegue en el segundo sin duplicar lógica en nodos del grafo.

## Riesgos y comprobaciones

- **Tool-calling:** distintos proveedores pueden comportarse distinto con el mismo esquema de tools; conviene probar HITL, `bash`, calendario y `schedule_task` / `manage_scheduled_tasks` al cambiar de proveedor.
- **Vertex:** región, API habilitada en el proyecto, permisos IAM del service account y cuotas.
- **Coste y límites:** no asumir que el fallback es gratis; acotar reintentos y registrar errores como ya hace el cron para tareas programadas.

## Plan de implementación (checklist técnico)

El desglose de tareas (dependencias npm, refactor de `model.ts` / `graph.ts`, clasificadores de error en el cron, etc.) se mantiene en un **plan local de Cursor**, no versionado en este repo, por convención del IDE. Busca en la máquina de desarrollo:

- `.cursor/plans/multi-provider_model_facade_*.plan.md`

(o el nombre actual del plan si fue renombrado). Ese archivo es complementario: **este** `.md` explica la idea; **aquél** lista pasos concretos de código.

Archivos previstos a tocar en la implementación: principalmente [`packages/agent/src/model.ts`](../../packages/agent/src/model.ts), [`packages/agent/src/graph.ts`](../../packages/agent/src/graph.ts) y, de forma menor, el runner [`apps/web/src/app/api/cron/scheduled-tasks/route.ts`](../../apps/web/src/app/api/cron/scheduled-tasks/route.ts) para alinear detección de errores persistentes con respuestas de Google.

## Relación con otros documentos

- Arquitectura general: [`docs/architecture.md`](../architecture.md) — tabla de stack y sección de modelo.
- Plan de producto: [`docs/plan.md`](../plan.md) — enlace al diseño multi-proveedor.

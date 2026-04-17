---
name: Tools de archivos
overview: Plan e implementación actual de `read_file`, `write_file` y `edit_file`. Todas las rutas son RELATIVAS a `FILE_TOOLS_ROOT`, sin escape. `write_file` crea o sobrescribe (medium risk, HITL). `edit_file` hace un reemplazo literal único (high risk, HITL). `read_file` es lectura pura con offset/limit por líneas (low risk, sin HITL).
todos:
  - id: catalog-entries
    content: Añadir las 3 entradas a TOOL_CATALOG con parameters_schema JSON
    status: completed
  - id: fileTools-module
    content: "Implementar fileTools.ts: resolveSafePath + read/write/edit con respuestas { ok, error } explícitas"
    status: completed
  - id: wire-adapters-graph
    content: Registrar handlers Zod en adapters.ts y mensajes de confirmación en graph.ts
    status: completed
  - id: onboarding-env
    content: TOOL_IDS en wizard.tsx y settings-form.tsx + step-tools.tsx + .env.example
    status: completed
  - id: selftest
    content: Self-test resolveSafePath (escape, absolutos, null bytes)
    status: completed
isProject: false
---

# Plan: tools `read_file`, `write_file`, `edit_file`

## Arquitectura real (post-implementación)

- **`packages/agent/src/tools/catalog.ts`** — `TOOL_CATALOG` es un array de `ToolDefinition` (`id`, `name`, `description` en inglés para el modelo, `risk`, `parameters_schema` JSON, opcional `requires_integration`). Helpers `getToolRisk` / `toolRequiresConfirmation` (confirma si `risk` es `medium` o `high`).
- **`packages/agent/src/tools/adapters.ts`** — `buildLangChainTools(ctx)` filtra por `isToolAvailable(toolId, ctx)` (herramienta habilitada + integración activa + gates de env). Por cada tool, registra un `tool(handler, { name, description, schema: zObject })`. **No existe `withTracking` genérico ni `TOOL_HANDLERS` / `TOOL_SCHEMAS` separados**: el handler y el schema Zod se pasan inline al registrar la tool (sólo los tools de GitHub escriben `tool_calls` a BD directamente con `createToolCall` / `updateToolCallStatus`).
- **`packages/agent/src/graph.ts`** — `toolExecutorNode` inspecta el mensaje del modelo; si alguna `tool_call` requiere confirmación (`toolRequiresConfirmation`), crea el registro pending en BD y lanza `interrupt({ pendingConfirmation: { message, ... } })`. Aquí se define `confirmationMessage(toolName, args)` con ramas por tool.
- **`packages/agent/src/tools/fileTools.ts`** — módulo único con `resolveSafePath`, `executeReadFile`, `executeWriteFile`, `executeEditFile`. Respuestas **siempre** `{ ok: true, ... }` o `{ ok: false, tool, path?, error: { code, message } }`; nunca lanza excepciones salvo bugs.

```mermaid
flowchart LR
  catalog[TOOL_CATALOG]
  adapters[adapters.ts<br/>tool&#40;&#41; handler + Zod]
  file[fileTools.ts<br/>resolveSafePath + exec*]
  graph[graph.ts<br/>toolExecutorNode + HITL]
  catalog --> adapters
  file --> adapters
  adapters --> graph
```

## Decisiones de diseño (implementación actual)

| Aspecto | Decisión |
| ------- | -------- |
| **Riesgos** | `read_file`: `low` (sin HITL). `write_file`: `medium` (HITL, crea o **sobrescribe**). `edit_file`: `high` (HITL, puede corromper sintaxis si `old_string` es mal elegido). |
| **Gate de entorno** | `FILE_TOOLS_ENABLED=true` **y** `FILE_TOOLS_ROOT=<ruta absoluta>`. Faltar cualquiera de las dos ⇒ `isToolAvailable(...)` devuelve `false` y el modelo no la ve. Fail-closed igual que `bash`. |
| **Alcance de paths** | Todos los `path` son **relativos** a `FILE_TOOLS_ROOT`. `resolveSafePath` rechaza rutas absolutas (Unix y Windows), null bytes, y cualquier ruta resuelta que no empiece con `FILE_TOOLS_ROOT + sep` (previene `..`, symlinks de nivel textual, etc.). |
| **`offset` / `limit` en `read_file`** | 1-based líneas. Default: leer hasta `5000` líneas o `1_000_000` bytes, lo que venga primero. Devuelve `startLine`, `endLine`, `totalLines`, `truncated`. |
| **`write_file`** | Crea directorios padre (`mkdir recursive`) y escribe UTF-8. Si el archivo ya existía, **sobrescribe**; el resultado indica `created` vs `overwritten`. Tope: `1_000_000` bytes. Rechaza escribir sobre un directorio. |
| **`edit_file`** | Lee UTF-8, exige **exactamente una** ocurrencia literal de `old_string`. 0 ⇒ `no_match`; >1 ⇒ `multiple_matches`. No es regex. Rechaza si el archivo no existe (sugiere `write_file`). |
| **Salida** | Estable por tool: `{ ok: true, tool, path, ... }` o `{ ok: false, tool, path?, error: { code, message } }`. Todas las respuestas se serializan con `JSON.stringify` al volver al modelo. |

## Textos de catálogo (implementación)

Ver `packages/agent/src/tools/catalog.ts`. Breve:

- `read_file` (low): lectura de archivo de texto dentro del workspace, `path` relativo + `offset` / `limit` opcionales en líneas.
- `write_file` (medium): crea o sobrescribe el archivo completo. Requiere confirmación.
- `edit_file` (high): reemplazo literal único (`old_string` debe aparecer exactamente una vez). Requiere confirmación.

## Archivos tocados

- `packages/agent/src/tools/catalog.ts` — 3 entradas nuevas.
- `packages/agent/src/tools/fileTools.ts` — **nuevo módulo** con `resolveSafePath`, `executeReadFile`, `executeWriteFile`, `executeEditFile` y constantes de tope.
- `packages/agent/src/tools/adapters.ts` — 3 handlers con Zod inline + gate `FILE_TOOLS_ENABLED` / `FILE_TOOLS_ROOT` en `isToolAvailable`.
- `packages/agent/src/graph.ts` — ramas `write_file` / `edit_file` en `confirmationMessage`.
- `packages/agent/src/tools/fileTools.selftest.ts` — pruebas de `resolveSafePath` (escape, absolutos, null bytes, etc.).
- `packages/agent/package.json` — script `test:file-tools`.
- `apps/web/src/app/onboarding/wizard.tsx` — `TOOL_IDS` incluye los 3 ids.
- `apps/web/src/app/settings/settings-form.tsx` — `TOOL_IDS` incluye los 3 ids.
- `apps/web/src/app/onboarding/steps/step-tools.tsx` — entradas UI con riesgo y copy en español.
- `apps/web/.env.example` — documenta `FILE_TOOLS_ENABLED` y `FILE_TOOLS_ROOT`.

No hay migración SQL: `user_tool_settings` se rellena al guardar onboarding / settings.

## ¿Por qué `FILE_TOOLS_ROOT` es necesaria?

Sin una raíz fija el modelo puede escribir en cualquier ruta del servidor (incluidos `~/.ssh`, `/etc`, `C:\Windows`, etc.). `FILE_TOOLS_ROOT` es la **única fuente de verdad** de "qué puede tocar el agente" en el host:

- `resolveSafePath` fuerza que `path.resolve(root, userPath)` empiece por `root + sep`. Si el modelo mete `../..`, `/etc/passwd` o `C:\Windows\...`, se rechaza.
- Permite al operador cambiar el sandbox sin tocar código (p. ej. una carpeta dedicada por entorno: `C:\agent-workspace` en local, `/srv/agent-workspace` en prod).
- Es independiente de `BASH_TOOL_CWD`: `bash` y las file tools pueden operar en raíces distintas si se quiere.

## Pruebas

- `npm run --workspace @agents/agent test:file-tools` — self-test de `resolveSafePath` (paths relativos, absolutos Unix/Windows, `..`, null bytes, string vacío).
- Manual:
  - `read_file` con y sin `offset`/`limit`; archivo inexistente ⇒ `ok: false` con `code: "not_found"`.
  - `write_file` en path nuevo ⇒ `created: true`; reintentar mismo path ⇒ `overwritten: true` (tras confirmar de nuevo).
  - `edit_file` con match único ⇒ `ok: true, replacements: 1`; 0 matches ⇒ `no_match`; 2 matches ⇒ `multiple_matches`.
  - HITL: `write_file` y `edit_file` muestran tarjeta de confirmación con ruta y preview; `read_file` se ejecuta sin preguntar.
  - Gate: sin `FILE_TOOLS_ENABLED=true` o sin `FILE_TOOLS_ROOT`, las 3 tools desaparecen de la lista que recibe el modelo.

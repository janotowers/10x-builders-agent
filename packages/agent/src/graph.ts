import {
  StateGraph,
  Annotation,
  interrupt,
  Command,
  type StreamMode,
} from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import {
  getSessionMessages,
  addMessage,
  createToolCall,
  findExistingPendingToolCall,
  updateToolCallStatus,
} from "@agents/db";
import type {
  UserToolSetting,
  UserIntegration,
  PendingConfirmation,
} from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { toolRequiresConfirmation } from "./tools/catalog";
import { getCheckpointer } from "./checkpointer";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  pendingConfirmation: Annotation<PendingConfirmation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * When true, tools that would normally trigger an HITL interrupt are executed
   * directly. Used by the cron runner: the user already approved the
   * `schedule_task` itself, so inner tools should not require a second approval.
   */
  autoApproveTools: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

export interface AgentInput {
  message?: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  /** Profile timezone for interpreting/creating calendar events. */
  userTimezone?: string;
  googleCalendarAccessToken?: string;
  resumeDecision?: "approve" | "reject";
  /** Must match the thread_id used when the interrupt was created. */
  checkpointThreadId?: string;
  /**
   * When true, the agent skips HITL interrupts and executes risky tools directly.
   * Intended for the cron runner of `schedule_task` (the user already approved
   * the scheduling, so inner tools should not require a second confirmation).
   */
  autoApproveTools?: boolean;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

function normalizeMessageContentToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && "text" in p
      )
      .map((p) => p.text)
      .join("")
      .trim();
  }
  return raw ? String(raw) : "";
}

/**
 * Last AIMessage with non-empty text in the **current user turn** (after the latest HumanMessage).
 * Avoids returning an older assistant reply from chat history when the latest model output is empty.
 */
function getLastAssistantText(messages: BaseMessage[]): string {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx < 0) return "";

  for (let i = messages.length - 1; i > lastHumanIdx; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const text = normalizeMessageContentToString(m.content);
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}

/** Inyectado cuando hay tools de creación en GitHub: el modelo suele confundir repo nuevo vs issue. */
const GITHUB_CREATE_TOOLS_ADDENDUM = `

[Reglas GitHub — obligatorias]
- Si el usuario pide crear un NUEVO repositorio (crear repositorio, nuevo repo, crear repo, new repository, etc.), usa ÚNICAMENTE la herramienta github_create_repo. El parámetro "name" es solo el slug del repo (ej. mi-app), sin owner ni barra "/".
- Si el usuario NO dijo un nombre concreto para el repositorio, NO llames a github_create_repo. Responde en texto y pregunta cómo quiere llamarlo (un solo slug corto). No inventes ni reutilices nombres de ejemplos anteriores.
- github_create_issue sirve SOLO para abrir un ticket/issue dentro de un repositorio que YA EXISTE. No la uses para crear el repositorio en sí.
- Títulos como "Nuevo repositorio X" en un pedido de crear proyecto en GitHub indican github_create_repo con name="X", no create_issue.
- NUNCA uses github_create_repo en un turno de CALENDARIO. Si el usuario está creando/listando eventos, citas o agendas, NO llames a ninguna herramienta de GitHub aunque el mensaje contenga palabras que se parezcan a nombres de repos. Usa SOLO las herramientas calendar_*.`;

const GITHUB_SOCIAL_ADDENDUM = `

[Reglas GitHub — saludos y presencia]
- Si el usuario solo saluda o pregunta si sigues ahí ("hola", "¿sigues ahí?", "estás ahí", "ping", "gracias", "¿qué tal?"), responde en texto natural. NO uses NINGUNA herramienta de GitHub (ni list_repos, ni list_issues, ni create_repo, ni create_issue). Un saludo no es una petición de datos ni una acción en GitHub.`;

function appendGithubCreateToolRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("github_create_issue") && !names.has("github_create_repo")) {
    return basePrompt;
  }
  return `${basePrompt.trimEnd()}${GITHUB_CREATE_TOOLS_ADDENDUM}`;
}

function appendGithubSocialRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  const hasAnyGithub =
    names.has("github_list_repos") ||
    names.has("github_list_issues") ||
    names.has("github_create_repo") ||
    names.has("github_create_issue");
  if (!hasAnyGithub) return basePrompt;
  return `${basePrompt.trimEnd()}${GITHUB_SOCIAL_ADDENDUM}`;
}

function buildBashAddendum(): string {
  let shellLine: string;
  try {
    const { getActiveShellName } = require("./tools/bashExec") as {
      getActiveShellName: () => string;
    };
    const shell = getActiveShellName();
    shellLine =
      shell === "powershell"
        ? "- IMPORTANTE: El servidor corre en **Windows con PowerShell** (no se encontró bash). Usa sintaxis de PowerShell: Get-ChildItem (no ls -la), Get-Content (no cat). Los flags Unix como -la NO funcionan."
        : `- El servidor usa **${shell}**. Usa sintaxis bash/Unix estándar (ls, cat, pwd, etc.).`;
  } catch {
    shellLine =
      "- Usa sintaxis bash estándar (ls, cat, pwd, etc.).";
  }
  return `

[Reglas herramienta bash — obligatorias]
- Si el usuario pide archivos o carpetas del SERVIDOR (donde corre la app), "carpeta actual", "directorio actual", "listar archivos aquí" → usa SOLO la herramienta bash con el comando adecuado. NO uses github_list_repos: esa herramienta lista repositorios remotos en GitHub, no archivos del disco del servidor.
- github_list_repos solo cuando pide explícitamente sus repositorios/proyectos en GitHub, "mis repos en GitHub", listado de repos remotos, etc.
${shellLine}`;
}

function appendBashRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("bash")) return basePrompt;
  return `${basePrompt.trimEnd()}${buildBashAddendum()}`;
}

const FILE_TOOLS_ADDENDUM = `

[Reglas herramientas de archivos (read_file / write_file / edit_file) — obligatorias]
- Llama DIRECTAMENTE a la herramienta apropiada (read_file / write_file / edit_file). NO pidas confirmación en texto ("¿confirmas?", "¿procedo?"): write_file y edit_file ya muestran una tarjeta de confirmación automática al usuario antes de escribir en disco. Tu trabajo es generar el tool_call correcto con los parámetros, no pedir permiso verbal.
- Si el usuario pide el contenido de un archivo del proyecto o del workspace del servidor, usa read_file con el parámetro path RELATIVO a la raíz del workspace (FILE_TOOLS_ROOT), por ejemplo "docs/plan.md", ".cursor/rules/algo.md" o "packages/agent/package.json". Nunca pases rutas absolutas (C:\\\\..., /home/..., /etc/...): la herramienta las rechaza.
- Un **título** o nombre para humanos (p. ej. "1_Agente (Chat en Cursor) - Project Rules and Guidelines") **no es** una ruta de archivo. Si el usuario solo da un título sin ruta, no inventes el path: explica que necesitas la ruta relativa dentro del repo, o usa la herramienta bash (si está disponible) para buscar el archivo en el directorio de trabajo del servidor (p. ej. PowerShell: Get-ChildItem -Recurse -File | Where-Object { $_.Name -like '*fragmento*' }) y luego read_file con la ruta relativa encontrada respecto a FILE_TOOLS_ROOT.
- Para edit_file, old_string debe aparecer EXACTAMENTE UNA VEZ en el archivo; si puede haber varias coincidencias, incluye contexto literal alrededor (mismos espacios y saltos de línea) para hacerla única. Si falla con "multiple_matches" o "no_match", ajusta el fragmento y vuelve a intentar.
- Tras read_file, resume el contenido al usuario; si el JSON devuelve ok:false (p. ej. not_found, invalid_path), explica el error y sugiere comprobar la ruta o permisos.`;

function appendFileToolsRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  const hasFileTools =
    names.has("read_file") ||
    names.has("write_file") ||
    names.has("edit_file");
  if (!hasFileTools) return basePrompt;
  return `${basePrompt.trimEnd()}${FILE_TOOLS_ADDENDUM}`;
}

const SCHEDULE_TASK_ADDENDUM = `

[Reglas herramienta schedule_task — obligatorias]
- Usa schedule_task cuando el usuario quiera que el agente haga algo en un momento futuro. Reconoce estas formas:
  · Hora de hoy: "hoy a las 19:45", "a las 8 de la noche", "en 30 minutos", "dentro de una hora", "a las X de hoy".
  · Fecha futura: "el viernes a las 9", "mañana a las 10 am", "el 25 de abril a las 9".
  · Recurrente: "todos los lunes a las 9", "cada día a las 8 am", "cada semana".
  · Verbos guía: "recuérdame", "programa", "avísame", "consulta X a las Y", "mándame X cada Z".
- El campo 'prompt' es la instrucción que el agente ejecutará a esa hora (escríbela como si fuera un mensaje directo al agente). Sé MUY específico, incluyendo el comando exacto a ejecutar cuando aplique.
  · Ejemplo Hacker News (preferir API JSON, no scraping HTML):
    "Usa bash para correr: ids=$(curl -sS https://hacker-news.firebaseio.com/v0/topstories.json | head -c 300 | tr -d '[]' | tr ',' '\n' | head -10); for id in $ids; do curl -sS https://hacker-news.firebaseio.com/v0/item/$id.json | head -c 600; echo; done. Devuélveme los títulos y URLs de las 5 historias más relevantes en español."
  · Ejemplo URL genérica:
    "Usa bash para correr: curl -sS -L -A 'Mozilla/5.0' https://EJEMPLO.com/ | head -c 4000. Resume el contenido principal en español."
- Siempre extrae o pregunta: qué debe hacer el agente (prompt), cuándo (fecha/hora o expresión recurrente), y timezone (usa la del perfil si no se especifica).
- Para one_time: calcula run_at como ISO 8601 con offset de zona (p.ej. 2026-04-18T19:45:00-06:00). Usa la fecha local actual del usuario como referencia. NUNCA uses fechas pasadas.
- Para recurring: usa expresiones cron de 5 campos estándar. Si el usuario dice "todos los lunes a las 9", usa "0 9 * * 1".
- El resultado de la tarea se enviará por Telegram al usuario. Si el usuario no tiene Telegram vinculado, la ejecución se registra pero no hay notificación en tiempo real.
- schedule_task es riesgo medio: la herramienta mostrará tarjeta de confirmación. Llama directamente a la herramienta sin pedir permiso en texto.
- Si el prompt programado requiere acceder a una URL o ejecutar un comando (bash), inclúyelo literalmente en el campo prompt. El agente que se ejecute a esa hora decidirá qué herramientas usar.`;

function appendScheduleTaskRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("schedule_task")) return basePrompt;
  return `${basePrompt.trimEnd()}${SCHEDULE_TASK_ADDENDUM}`;
}

/** Injected when the cron runner executes a stored prompt (autoApproveTools). */
const CRON_SCHEDULED_EXECUTION_ADDENDUM = `

[Ejecución automática (tarea programada) — obligatorias]
- Esta petición es la ejecución de una tarea que el usuario YA aprobó al programarla. No digas que no puedes programar acciones futuras ni que no puedes acceder a sitios web: ejecuta lo pedido ahora.
- Si el mensaje pide datos de una URL o ejecutar un comando en terminal, usa SIEMPRE la herramienta bash (está habilitada en el servidor) y devuelve un resumen útil en texto.
- No respondas con "no se pudo obtener" sin haber llamado primero a la herramienta bash. Si la primera llamada a bash devuelve poco texto o un error, REINTENTA con flags adicionales: curl -sS -L -A 'Mozilla/5.0' <URL> | head -c 8000. Si sigue fallando, reporta el exit code y el stderr literal del bash, no inventes la causa.
- Para Hacker News, prefiere la API JSON: https://hacker-news.firebaseio.com/v0/topstories.json y https://hacker-news.firebaseio.com/v0/item/<id>.json (mucho más fácil de parsear que el HTML).
- No vuelvas a llamar a schedule_task para lo mismo salvo que el mensaje lo pida explícitamente.`;

const CALENDAR_TOOLS_ADDENDUM = `

[Reglas Google Calendar — obligatorias]
- Si el usuario pide eventos, citas, agenda o calendario, usa las herramientas calendar_* (p. ej. calendar_list_events con calendar_id "primary"). No uses herramientas GitHub para esas peticiones.
- Al CREAR un evento (calendar_create_event), usa SIEMPRE calendar_id="primary" salvo que el usuario diga explícitamente en QUÉ calendario quiere crearlo ("en el calendario Lab10", "en mi calendario de trabajo"). El nombre del evento NO es el nombre del calendario — no confundas "curso Lab10" (título del evento) con el calendario llamado "Lab10".
- github_create_repo / github_create_issue son solo para repositorios e issues en GitHub, nunca para citas o calendario.
- Si NO dijo período ("mis eventos", "qué tengo", "mi calendario"): llama calendar_list_events SIN time_min ni time_max → recibirás needs_period; haz UNA pregunta corta (hoy / esta semana / desde-hasta / etc.). No adivines fechas ni listes eventos hasta tener rango.
- Cuando tengas el período (explícito o acordado), convierte a time_min y time_max en ISO 8601 usando get_user_preferences.timezone (p. ej. America/Mexico_City). Pasa SIEMPRE ambos campos en la siguiente llamada.
- Interpretación de períodos naturales (usar semana lunes–domingo):
  · "hoy" → desde inicio del día actual (00:00) hasta fin (23:59:59) en la zona del perfil.
  · "mañana" → inicio y fin del día siguiente.
  · "esta semana" / "this week" → desde el lunes 00:00 de la semana en curso hasta el domingo 23:59:59 en la zona del perfil. NO es "desde ahora + 7 días".
  · "la próxima semana" / "next week" → lunes 00:00 al domingo 23:59:59 de la semana siguiente.
  · "este mes" → desde el día 1 00:00 hasta el último día 23:59:59 del mes en curso.
  · Si la fecha de hoy es jueves 9 de abril 2026, "esta semana" = lun 6 abr 00:00 → dom 12 abr 23:59:59.
- Al responder, usa los campos start_display y end_display de cada evento (hora local del perfil). No digas "UTC" salvo que el usuario lo pida.
- Respuestas cortas de período ("de esta semana", "hoy", "este mes") tras preguntar por el calendario → calendar_list_events con ISO en su timezone, NUNCA github_list_repos (eso son repositorios, no citas).
- historical=true solo si pidió historial o fechas pasadas claras. Si el JSON trae range_coerced o assistant_hint, explícalo y no mezcles años que no vengan del JSON.`;

function appendCalendarToolRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = lcTools
    .map((t) => t.name)
    .filter((n): n is string => Boolean(n));
  const hasCalendar = names.some((n) => n.startsWith("calendar_"));
  if (!hasCalendar) return basePrompt;
  return `${basePrompt.trimEnd()}${CALENDAR_TOOLS_ADDENDUM}`;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    userTimezone,
    googleCalendarAccessToken,
    resumeDecision,
    checkpointThreadId,
  } = input;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
    userTimezone,
    googleCalendarAccessToken,
    lastUserMessage: message ?? "",
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const now = new Date();
  const dateContext = `\n\n[Contexto temporal — generado automáticamente]\nFecha y hora actual del servidor: ${now.toISOString()}\nZona del usuario: ${userTimezone ?? "UTC"}\nFecha local del usuario: ${now.toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: userTimezone ?? "UTC" })}\nHora local: ${now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: userTimezone ?? "UTC" })}\nCuando el usuario dice "mañana", "hoy", "la próxima semana", etc., calcula las fechas ISO a partir de ESTA fecha. NUNCA uses fechas de 2023, 2024 ni 2025 salvo que el usuario las indique explícitamente.`;

  const ambiguityAddendum = `\n\n[Reglas de desambiguación — obligatorias]\n- Respuestas cortas del usuario como "sí", "ok", "dale", "va", "hazlo", "procede", "no", "cancela": interprétalas SIEMPRE en el contexto del ÚLTIMO turno TUYO inmediatamente anterior. Si tu último turno prometió una acción concreta en un dominio (archivos, calendario, github, bash) pero NO llamaste a la herramienta, ahora debes llamar a la herramienta DIRECTAMENTE con los parámetros ya acordados. No elijas otra acción de otro dominio sólo porque aparezca en el historial lejano.\n- Si no tienes una acción claramente pendiente en tu turno anterior, responde pidiendo clarificación al usuario (una sola pregunta corta) en vez de asumir. Nunca "adivines" creando eventos, archivos o repos para reusar datos de turnos viejos.\n- Nunca pidas confirmación en TEXTO para acciones que tienen herramienta con riesgo medio/alto: la herramienta ya disparará su propia tarjeta de confirmación. Genera el tool_call y deja que el sistema pida la aprobación.`;

  let effectiveSystemPrompt = appendScheduleTaskRules(
    appendFileToolsRules(
      appendCalendarToolRules(
        appendGithubSocialRules(
          appendBashRules(
            appendGithubCreateToolRules(
              systemPrompt + dateContext + ambiguityAddendum,
              lcTools as Array<{ name?: string }>
            ),
            lcTools as Array<{ name?: string }>
          ),
          lcTools as Array<{ name?: string }>
        ),
        lcTools as Array<{ name?: string }>
      ),
      lcTools as Array<{ name?: string }>
    ),
    lcTools as Array<{ name?: string }>
  );
  if (input.autoApproveTools) {
    effectiveSystemPrompt =
      effectiveSystemPrompt.trimEnd() + CRON_SCHEDULED_EXECUTION_ADDENDUM;
  }

  // DEBUG: descomentar las siguientes 2 líneas para ver el system prompt completo en la terminal del servidor
  // console.log("=== SYSTEM PROMPT ===\n", effectiveSystemPrompt, "\n=== END ===");
  // console.log("=== TOOLS REGISTERED ===", lcTools.map((t) => t.name).join(", "), "=== END ===");

  // Limitamos el contexto histórico para reducir contaminación entre turnos
  // (p. ej. un "sí" aislado que el modelo asocie a una acción vieja de otro dominio).
  const history = await getSessionMessages(db, sessionId, 12);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  if (!resumeDecision) {
    if (!message) {
      throw new Error("message is required for non-resume agent calls");
    }
    await addMessage(db, sessionId, "user", message);
  }

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];

    function confirmationMessage(
      toolName: string,
      args: Record<string, unknown>
    ): string {
      if (toolName === "github_create_repo") {
        return `Se necesita tu confirmación para crear el repositorio "${String(args.name ?? "")}"${args.private ? " (privado)" : ""}.`;
      }
      if (toolName === "github_create_issue") {
        return `Se necesita tu confirmación para crear el issue "${String(args.title ?? "")}" en ${String(args.owner ?? "")}/${String(args.repo ?? "")}.`;
      }
      if (toolName === "calendar_create_event") {
        const fmt = (iso: unknown): string => {
          try {
            const d = new Date(String(iso));
            if (isNaN(d.getTime())) return String(iso);
            return d.toLocaleString("es-MX", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: userTimezone ?? "America/Mexico_City",
            });
          } catch {
            return String(iso);
          }
        };
        return `Confirma crear el evento "${String(args.summary ?? "")}" de ${fmt(args.start_datetime)} a ${fmt(args.end_datetime)}.`;
      }
      if (toolName === "calendar_update_event") {
        return `Confirma actualizar el evento ${String(args.event_id ?? "")}.`;
      }
      if (toolName === "calendar_delete_event") {
        return `Confirma eliminar el evento ${String(args.event_id ?? "")}.`;
      }
      if (toolName === "bash") {
        const term = String(args.terminal ?? "default");
        const p = String(args.prompt ?? "");
        const preview = p.length > 200 ? `${p.slice(0, 200)}…` : p;
        return `Confirma ejecutar en el servidor (etiqueta: "${term}") el comando:\n${preview}`;
      }
      if (toolName === "write_file") {
        const p = String(args.path ?? "");
        const c = String(args.content ?? "");
        const bytes = Buffer.byteLength(c, "utf8");
        return `Confirma escribir (crear o sobrescribir) el archivo \`${p}\` en el workspace del servidor (${bytes} bytes).`;
      }
      if (toolName === "edit_file") {
        const p = String(args.path ?? "");
        const oldS = String(args.old_string ?? "");
        const newS = String(args.new_string ?? "");
        const short = (s: string) =>
          s.length > 120 ? `${s.slice(0, 120)}…` : s;
        return `Confirma editar el archivo \`${p}\`: reemplazar\n«${short(oldS)}»\npor\n«${short(newS)}».`;
      }
      if (toolName === "schedule_task") {
        const prompt = String(args.prompt ?? "");
        const type = String(args.schedule_type ?? "");
        const shortPrompt = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
        if (type === "one_time") {
          const when = args.run_at
            ? (() => {
                try {
                  return new Date(String(args.run_at)).toLocaleString("es-MX", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: userTimezone ?? "UTC",
                  });
                } catch {
                  return String(args.run_at);
                }
              })()
            : "hora no especificada";
          return `Confirma programar la siguiente tarea para el ${when}:\n«${shortPrompt}»`;
        }
        return `Confirma programar la tarea recurrente (${String(args.cron_expr ?? "")} ${String(args.timezone ?? "UTC")}):\n«${shortPrompt}»`;
      }
      return `Confirma ejecutar la herramienta ${toolName}.`;
    }

    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        const needsConfirmation = toolRequiresConfirmation(tc.name);
        let trackedToolCallId: string | null = null;

        if (needsConfirmation) {
          // Auto-approve mode: cron runner of a scheduled task.
          // The user already approved the schedule_task itself; bothering them
          // again at execution time defeats the purpose of "scheduled".
          if (state.autoApproveTools) {
            const toolCallRecord = await createToolCall(
              db,
              state.sessionId,
              tc.name,
              tc.args,
              false
            );
            trackedToolCallId = toolCallRecord.id;
            await updateToolCallStatus(db, toolCallRecord.id, "approved");
          } else {
            const existing = await findExistingPendingToolCall(
              db,
              state.sessionId,
              tc.name
            );
            const toolCallRecord =
              existing ??
              (await createToolCall(
                db,
                state.sessionId,
                tc.name,
                tc.args,
                true
              ));
            trackedToolCallId = toolCallRecord.id;
            const decision = interrupt({
              tool_call_id: toolCallRecord.id,
              tool_name: tc.name,
              message: confirmationMessage(tc.name, tc.args),
              args: tc.args,
            }) as "approve" | "reject";
            if (decision !== "approve") {
              await updateToolCallStatus(db, toolCallRecord.id, "rejected");
              results.push(
                new ToolMessage({
                  content: JSON.stringify({
                    message: "Acción cancelada por el usuario.",
                  }),
                  tool_call_id: tc.id!,
                })
              );
              continue;
            }
            await updateToolCallStatus(db, toolCallRecord.id, "approved");
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const resultStr = String(result);
        results.push(
          new ToolMessage({ content: resultStr, tool_call_id: tc.id! })
        );

        if (trackedToolCallId) {
          try {
            const parsed = JSON.parse(resultStr) as Record<string, unknown>;
            const hasError =
              typeof parsed === "object" &&
              parsed !== null &&
              typeof parsed.error === "string";
            if (hasError) {
              await updateToolCallStatus(
                db,
                trackedToolCallId,
                "failed",
                parsed
              );
            } else {
              await updateToolCallStatus(
                db,
                trackedToolCallId,
                "executed",
                parsed
              );
            }
          } catch {
            await updateToolCallStatus(db, trackedToolCallId, "executed", {
              raw: resultStr,
            });
          }
        }
      } else {
        const unavailablePayload: Record<string, unknown> = {
          error: "tool_not_available",
          tool_name: tc.name,
          message:
            "Esta herramienta no está disponible (integración inactiva, herramienta deshabilitada o no cargada en el servidor). Di al usuario qué falta sin inventar datos — p. ej. conectar Google Calendar en Ajustes si pidió calendarios.",
        };
        try {
          const record = await createToolCall(
            db,
            state.sessionId,
            tc.name,
            (tc.args as Record<string, unknown>) ?? {},
            false
          );
          await updateToolCallStatus(db, record.id, "failed", unavailablePayload);
        } catch (e) {
          console.error("[agent] tool_not_available audit row failed:", e);
        }
        results.push(
          new ToolMessage({
            content: JSON.stringify(unavailablePayload),
            tool_call_id: tc.id!,
          })
        );
      }
    }

    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "agent");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });

  // Each new (non-resume) call gets a fresh thread_id so the checkpoint's
  // appending message reducer doesn't accumulate stale context across turns.
  // Resume calls MUST reuse the thread_id from the interrupted run.
  const threadId = resumeDecision
    ? checkpointThreadId ?? sessionId
    : `${sessionId}-${Date.now()}`;

  const config = {
    configurable: { thread_id: threadId },
    streamMode: ["values", "updates"] as StreamMode[],
  };

  const graphInput = resumeDecision
    ? new Command({ resume: resumeDecision })
    : {
        messages: [
          new SystemMessage(effectiveSystemPrompt),
          ...priorMessages,
          new HumanMessage(message!),
        ],
        sessionId,
        userId,
        systemPrompt,
        pendingConfirmation: null,
        autoApproveTools: input.autoApproveTools ?? false,
      };

  /** Populated from stream "updates" chunks when interrupt() fires (not present on state schema). */
  let interruptsFromStream: Array<{ value?: unknown }> | undefined;

  function normalizeStreamChunk(raw: unknown): { mode: string; payload: unknown } | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    if (raw.length === 2) {
      return { mode: String(raw[0]), payload: raw[1] };
    }
    // Subgraphs / some builds yield [namespace, mode, payload]
    return { mode: String(raw[1]), payload: raw[2] };
  }

  function extractInterruptsFromUpdatesPayload(
    payload: unknown
  ): Array<{ value?: unknown }> | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    const top = p.__interrupt__;
    if (Array.isArray(top) && top.length > 0) {
      return top as Array<{ value?: unknown }>;
    }
    for (const v of Object.values(p)) {
      if (v && typeof v === "object" && "__interrupt__" in (v as object)) {
        const ir = (v as Record<string, unknown>).__interrupt__;
        if (Array.isArray(ir) && ir.length > 0) {
          return ir as Array<{ value?: unknown }>;
        }
      }
    }
    return undefined;
  }

  const stream = await app.stream(graphInput, config);
  for await (const raw of stream) {
    const parsed = normalizeStreamChunk(raw);
    if (!parsed) continue;
    if (parsed.mode === "updates") {
      const ir = extractInterruptsFromUpdatesPayload(parsed.payload);
      if (ir?.length) interruptsFromStream = ir;
    }
  }

  const snapshot = await app.getState({ configurable: { thread_id: threadId } });
  const finalState = snapshot.values as typeof GraphState.State;
  if (!finalState) {
    throw new Error("LangGraph checkpoint has no state values");
  }

  let pending: PendingConfirmation | null = null;
  const interrupts =
    interruptsFromStream ??
    (finalState as { __interrupt__?: Array<{ value?: unknown }> }).__interrupt__;
  if (interrupts?.length) {
    const payload = interrupts[0]?.value as
      | {
          tool_call_id?: string;
          tool_name?: string;
          message?: string;
          args?: Record<string, unknown>;
        }
      | undefined;
    if (
      payload?.tool_call_id &&
      payload.tool_name &&
      payload.message &&
      payload.args
    ) {
      pending = {
        toolCallId: payload.tool_call_id,
        toolName: payload.tool_name,
        message: payload.message,
        args: payload.args,
        checkpointThreadId: threadId,
      };
      await addMessage(db, sessionId, "assistant", payload.message, {
        tool_call_id: payload.tool_call_id,
        structured_payload: {
          type: "pending_confirmation",
          pendingConfirmation: pending,
        },
      });
    }
  }

  let responseText = "";
  if (!pending) {
    responseText = getLastAssistantText(finalState.messages);

    if (!responseText && resumeDecision === "reject") {
      responseText = "Acción cancelada por el usuario.";
    }

    if (!responseText.trim()) {
      responseText =
        "No pude generar una respuesta en este turno. Revisa integraciones y herramientas en Ajustes e inténtalo de nuevo.";
    }

    if (responseText.trim().length > 0) {
      await addMessage(db, sessionId, "assistant", responseText);
    }
  }

  return {
    response: responseText,
    toolCalls: toolCallNames,
    pendingConfirmation: pending,
  };
}

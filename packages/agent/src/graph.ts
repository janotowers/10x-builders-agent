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
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

/** Inyectado cuando hay tools de creación en GitHub: el modelo suele confundir repo nuevo vs issue. */
const GITHUB_CREATE_TOOLS_ADDENDUM = `

[Reglas GitHub — obligatorias]
- Si el usuario pide crear un NUEVO repositorio (crear repositorio, nuevo repo, crear repo, new repository, etc.), usa ÚNICAMENTE la herramienta github_create_repo. El parámetro "name" es solo el slug del repo (ej. mi-app), sin owner ni barra "/".
- Si el usuario NO dijo un nombre concreto para el repositorio, NO llames a github_create_repo. Responde en texto y pregunta cómo quiere llamarlo (un solo slug corto). No inventes ni reutilices nombres de ejemplos anteriores.
- github_create_issue sirve SOLO para abrir un ticket/issue dentro de un repositorio que YA EXISTE. No la uses para crear el repositorio en sí.
- Títulos como "Nuevo repositorio X" en un pedido de crear proyecto en GitHub indican github_create_repo con name="X", no create_issue.`;

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

const CALENDAR_TOOLS_ADDENDUM = `

[Reglas Google Calendar — obligatorias]
- Si el usuario pide eventos, citas, agenda o calendario, usa las herramientas calendar_* (p. ej. calendar_list_events con calendar_id "primary"). No uses herramientas GitHub para esas peticiones.
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

  const effectiveSystemPrompt = appendCalendarToolRules(
    appendGithubSocialRules(
      appendGithubCreateToolRules(
        systemPrompt,
        lcTools as Array<{ name?: string }>
      ),
      lcTools as Array<{ name?: string }>
    ),
    lcTools as Array<{ name?: string }>
  );

  // DEBUG: descomentar las siguientes 2 líneas para ver el system prompt completo en la terminal del servidor
  // console.log("=== SYSTEM PROMPT ===\n", effectiveSystemPrompt, "\n=== END ===");
  // console.log("=== TOOLS REGISTERED ===", lcTools.map((t) => t.name).join(", "), "=== END ===");

  const history = await getSessionMessages(db, sessionId, 30);
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
        return `Confirma crear el evento "${String(args.summary ?? "")}" del ${String(args.start_datetime ?? "")} al ${String(args.end_datetime ?? "")}.`;
      }
      if (toolName === "calendar_update_event") {
        return `Confirma actualizar el evento ${String(args.event_id ?? "")}.`;
      }
      if (toolName === "calendar_delete_event") {
        return `Confirma eliminar el evento ${String(args.event_id ?? "")}.`;
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
    const lastMessage = finalState.messages[finalState.messages.length - 1];
    const raw = lastMessage?.content;
    if (typeof raw === "string") {
      responseText = raw;
    } else if (Array.isArray(raw)) {
      // Content parts array — extract text parts only
      responseText = raw
        .filter(
          (p): p is { type: string; text: string } =>
            typeof p === "object" && p !== null && "text" in p
        )
        .map((p) => p.text)
        .join("")
        .trim();
    } else {
      responseText = raw ? String(raw) : "";
    }

    if (!responseText && resumeDecision === "reject") {
      responseText = "Acción cancelada por el usuario.";
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

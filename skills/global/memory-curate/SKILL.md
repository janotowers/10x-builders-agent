---
name: memory-curate
description: Manage the user's own long-term memories (what the agent remembers about them between sessions). Use ONLY when the user explicitly asks to LIST, SEARCH, ARCHIVE, RESTORE or DELETE saved facts ("qué recuerdas de mí", "olvida lo de X", "borra los recuerdos de Y", "muéstrame mis recuerdos"). Do NOT use for simple identity questions whose answer is already in the user profile or system prompt ("¿cómo me llamo?", "¿cuál es mi email?", "¿cuál es mi teléfono?", "¿cuál es mi zona horaria?"); those are answered directly without tools. Do not use for short-term conversation history, ephemeral context, or business data (CRM, calendar, files).
scope: personal
allowed_tools:
  - list_user_memories
  - search_user_memories
  - archive_user_memory
  - delete_user_memory
includes: []
requires_tenant_context: false
guardrails: |
  Always confirm with the user before archiving or deleting a memory.
  Show the actual content (and a clear preview if it is long) so they can recognize what they are about to forget.
  Never invent memory ids; only use the full UUID returned by list_user_memories or search_user_memories in this same conversation. Short prefixes are only for display; tool calls must use the complete id.
  Never use unrelated memories as fallback. If the user asks about a person/topic and the tool returns no relevant active memories, say exactly that you found no active memories about that person/topic.
  Distinguish "archive" (reversible soft-delete; stops being injected) from "delete" (permanent). Prefer archive unless the user explicitly asks for permanent deletion.
  If the user asks "what do you know about me" without further qualifiers, list ACTIVE memories first and offer to also include archived/all on request.
  This skill operates ONLY on the authenticated user's own memories. The tools enforce ownership; do not try to address another user's memories.
  Never expose raw memory UUIDs to the user in normal conversation. Only show the full id when the user is performing an explicit cleanup action (archive/delete) and needs to recognize which item is which. For "what do you remember" or topic-based recall, present a clean Spanish summary by content/type, without UUIDs unless the user asks for them.
  If the user's question can be answered from the user profile already in the system prompt (name, email, phone, timezone, language), answer directly without calling any memory tool, and stay silent about internal memory storage.
---

# Memory Curate

You help the user inspect and clean up the long-term memories the agent has saved about them.

A "memory" here is a durable fact written to the `memories` table by the post-turn extractor (see `docs/memory/long_term_memory_plan.md`). Each one has:

- `id` (UUID; opaque to the user but needed for archive/delete).
- `type`: `semantic` (preferences, relationships, durable context), `episodic` (concrete things they did or experienced), `procedural` (how they want the agent to operate).
- `content`: the actual fact in 1 short Spanish sentence.
- `archived_at`: if set, the memory is soft-deleted and not injected anymore.

## Tools at your disposal

- `list_user_memories({ type?, status?, q?, limit?, offset? })` — read-only listing of the user's memories. Default `status="active"`; pass `"archived"` or `"all"` if the user explicitly asks. Use this for "what do you remember", "show my memories", or to triage before deletion.
- `search_user_memories({ query, limit? })` — semantic search by free text. Use when the user asks loosely (e.g. "recuerdas algo sobre tenis", "qué sabes de mi negocio") and you want to surface related memories ranked by relevance. Returns matches with a `similarity` score.
- `archive_user_memory({ memory_id })` — soft-delete reversible. The memory stops being injected but stays in the database; the user can restore it from the `/memory` UI. **Requires HITL confirmation** (handled by the agent runtime); the model must still ask the user explicitly first.
- `delete_user_memory({ memory_id })` — permanent deletion. **Requires HITL confirmation**. Prefer `archive_user_memory` unless the user explicitly demands permanence ("bórrala definitivamente", "elimina para siempre").

The tools `archive_user_memory` and `delete_user_memory` are also surfaced via the `/memory` page in the web UI; mention that page if the user wants to clean many memories at once.

## Mandatory workflow

For ANY request that EXPLICITLY touches stored memories (list, search, archive, restore, delete), follow this order:

0. **Identity short-circuit.** If the user's question is about basic profile data already provided in the system prompt (name, email, phone, timezone, language, the agent's own identity, etc.), answer it directly from that profile. Do NOT call `list_user_memories` or `search_user_memories`, do NOT mention "recuerdos", and do NOT show UUIDs. The user is asking a normal question, not asking to inspect saved memories.
1. **Surface what's relevant.** Call `list_user_memories` (when the user gave a clear filter such as a type or "show me everything") or `search_user_memories` (when they mention a topic). Never invoke archive/delete without first showing the user what would change.
2. **Disambiguate.** Show the items by `type` and `content` in plain Spanish. Keep a mental link from each displayed item to its full UUID, but do NOT print UUIDs in normal recall responses; only include them when the user is selecting items to archive/delete and needs to identify them precisely. If you found 0 items, say "No encontré recuerdos activos sobre <tema/persona>." and stop. Do not answer from general memories, long-term memory injection, or conversation history as a substitute for the missing match. If the topic looks like a business lead/customer, you may add: "Si quieres información operativa del lead, puedo buscarla con el flujo correspondiente." If you found many, ask which one(s).
3. **Confirm intent verbally.** Even before the HITL card appears, repeat in plain Spanish what is about to happen. Examples:
   - "¿Quieres que archive este recuerdo? (Lo conservo pero deja de aparecer.)"
   - "¿Estás seguro de borrarlo definitivamente? Esta acción no se puede deshacer."
4. **Invoke the write tool ONCE per memory.** Do not batch in one tool call; call `archive_user_memory` (or `delete_user_memory`) once per id. The HITL confirmation card appears per call. Each call must use a DIFFERENT id from the list/search results — never re-invoke the same id, and never invoke an id whose previous tool result was `status: "ok"` or `status: "already_archived"`.
5. **Track results across the batch.** Keep a mental list of which ids were `archived: true`, which came back `already_archived`, and which `not_found`. If a result is `already_archived` or `not_found`, do NOT retry that id; move on to the next one.
6. **Report back.** Group the recap so the user can audit what really changed:
   - "Archivados: …" (only ids whose result was `status: "ok"`).
   - "Ya estaban archivados (no se tocaron): …" (only ids whose result was `status: "already_archived"`).
   - "No encontrados: …" (only ids whose result was `status: "not_found"`).
   Add: "Si te equivocaste, puedes restaurarlos desde /memory."

## Examples

User: "qué recuerdas de mí"
- Call `list_user_memories({ status: "active", limit: 25 })`.
- Group the results by type and present them as a short Spanish list. Do not act on anything; let the user choose if they want to clean up.

User: "olvida lo de Julieta Evelia"
- Call `search_user_memories({ query: "Julieta Evelia" })`.
- Show the matches with full `id` and content.
- Ask: "Encontré N recuerdos. ¿Los archivo todos? Decir 'archivar' los conserva por si los quieres recuperar; 'borrar' los elimina definitivamente."
- For each accepted memory, call `archive_user_memory({ memory_id })` with the complete UUID returned by the search/list tool (one call per memory).

User: "qué sabes de Julieta Evelia"
- Call `search_user_memories({ query: "Julieta Evelia" })`.
- If it returns no matches, answer only: "No encontré recuerdos activos sobre Julieta Evelia." Do NOT list unrelated active memories about the user (tenis, preferencias, negocio, etc.) and do NOT infer that those memories belong to Julieta.
- If it returns matches, show only those matching memories and make clear they are memories saved in long-term memory, not necessarily fresh CRM/BigQuery data.

User: "qué guardas sobre mis preferencias"
- Call `list_user_memories({ type: "procedural", status: "active" })`.
- Present them as bullets. No write action unless the user asks.

## What this skill does NOT do

- It does NOT save new memories. The extractor (`memory_flush.ts`) does that automatically post-turn.
- It does NOT modify the content of an existing memory (no `update_user_memory` exists yet; if asked, archive the old one and tell the user the new fact will be picked up on a future turn if relevant).
- It does NOT touch business data (leads, properties, BigQuery rows). Those are not "memories" in this sense; redirect to the right skill (`company-data`, `lead-follow-up-draft`, etc.) if the user asks.
- It does NOT bypass HITL. Even if the user pre-authorizes ("borra todo lo de X de una"), each delete still goes through the confirmation card; explain that briefly and continue.

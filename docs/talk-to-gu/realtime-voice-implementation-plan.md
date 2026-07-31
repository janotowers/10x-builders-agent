# Gu OS — Realtime Voice Spike: Detailed Implementation Plan

**Governing source:** [Talk to Gu product and architecture vision](./vision.md). Este documento traduce la primera etapa de esa visión a slices ejecutables; no redefine la visión. Es hermano **en formato**, no en dependencia, de `docs/manuals/gu-os-flexible-workflows-detailed-implementation-plan.md`.

**Convención:** `[ ]` pending · `[x]` done · `[~]` in progress · `[!]` blocked. Si la implementación contradice una decisión de §0, registrarla en §X y pedir decisión.

---

## 0. Decisiones normativas

### 0.1 Objetivo

Demo interna **Talk to Gu**: un asesor autenticado conversa por voz desde la web, interrumpe naturalmente, consulta propiedades, leads, casos y agenda, ve transcript y artefactos visuales, y puede entregar un resultado a su Telegram verificado. El spike es read-only, flagged, sin telefonía ni escritura.

### 0.2 Grok es la boca; Gu OS es el cerebro

- Grok Voice maneja audio, VAD, turn-taking, interrupciones, conversación social y lectura.
- Gu OS conserva skills, tenant context, tool policy, decisiones, casos y workflows.
- Grok recibe 3–5 capabilities read-only estrechas y `ask_gu(question)` para la cola larga.
- El manifest de voz nunca se deriva de `TOOL_CATALOG`; duplicar tools/políticas crearía una segunda inteligencia operacional.

### 0.3 Proveedor inicial

| Ítem | Decisión que V0 debe verificar |
| --- | --- |
| Modelo | `grok-voice-think-fast-2.0`, ID versionado; nunca `grok-voice-latest` |
| Transporte | WebSocket bidireccional `wss://api.x.ai/v1/realtime?model=…` |
| Precio esperado | USD 0.08/min de audio total + USD 0.004 por input de texto |
| Browser auth | Ephemeral token server-side; `XAI_API_KEY` nunca al navegador |
| Idioma | es-MX + keyterms si el API lo soporta |

Voice Agent Builder solo sirve para exploración desechable; no será control plane de Gu OS.

**Alternativas futuras** (GPT-Realtime-2.1, Gemini 3.1 Flash Live, cascada STT→Gu→TTS, LiveKit) y criterios para introducir un segundo proveedor: ver [visión §10](./vision.md#10-proveedores-de-voz-primera-opción-y-alternativas). El spike implementa solo `XaiRealtimeProvider` + fallback a texto; el contrato `RealtimeVoiceProvider` deja la puerta abierta sin construir multi-provider ahora.

### 0.4 Evidencia del repo (2026-07-31)

- `Channel` es un union cerrado en `packages/types/src/index.ts`; `agent_sessions.channel` tiene CHECK en DB.
- `runAgent` es el runtime común, pero no existe un framework homogéneo de adapters: web y Telegram ejecutan `resolvePendingDecisionTurn` antes del agente.
- HITL persiste `pendingConfirmation` y reanuda `runAgent({ resumeDecision })`.
- Flags por tenant viven en `account_feature_flags`; env vars son kill-switches globales.
- `ai_usage_events` es append-only; su CHECK de `operation` no admite audio todavía.
- Leads/KPIs usan la skill `company-data` + `bigquery_run_query`; esa tool no se expone a Grok.
- Hay bases read-only para EasyBroker, casos y calendario.
- Telegram ya envía documentos al asesor, recibe fotos/documentos y maneja media groups.
- El plan de workflows reserva `00069_work_plane.sql`; asignar migraciones de voz al implementar.

### 0.5 Reglas permanentes

1. Flag tenant `voice_realtime` **AND** `VOICE_REALTIME_ENABLED=true`.
2. API key solo server-side.
3. Modelo versionado pinneado.
4. Cero tools de escritura en V0–V5.
5. Sesión realtime efímera; mensajes, tool calls, casos y artefactos son durables.
6. Metering desde la primera sesión.
7. Intención operacional → `runConversationalTurn` → gates → `runAgent`.
8. Toda query nueva requiere `userId`; nunca cross-tenant.
9. Voz y visual derivan de un mismo resultado estructurado.
10. Gu solo afirma una entrega después de recibir confirmación.

---

## V0 — Validación manual del proveedor

**Status:** [ ] pending

- [ ] Crear team en xAI Console, crédito prepago y límites.
- [ ] Confirmar modelo, precio, endpoint y disponibilidad.
- [ ] Probar es-MX con nombres, colonias, correos, teléfonos y montos (“4.8 millones” vs “48 millones”).
- [ ] Verificar ephemeral tokens, async function calls, VAD, keyterms, límites y resumption.
- [ ] Documentar diferencias con OpenAI Realtime.
- [ ] Revisar región, retención, ZDR y política aplicable al piloto.

**Evidence:** findings en §X. **Costo:** < USD 5. **Depends on:** nothing.

---

## V1 — Canal, flag, provider contract y ephemeral token

**Status:** [ ] pending

- [ ] Extender `Channel` y consumidores con `"voice"`.
- [ ] Migración `000NN_voice_channel.sql`: extender CHECK de `agent_sessions.channel`.
- [ ] `isVoiceRealtimeEnabled(userId)`: flag tenant + kill-switch global.
- [ ] Contrato en `apps/web/src/lib/voice/provider.ts`: `createSession`, `updateSession`, `sendToolResult`, `interrupt`, `closeSession`.
- [ ] Eventos normalizados: speech started, transcripts, audio delta, tool request, end, error.
- [ ] `XaiRealtimeProvider`: mapear protocolo xAI y config es-MX.
- [ ] `POST /api/voice/session`: Supabase auth → flag → ephemeral token.

**Tests:** fixtures de eventos y gating. **Rollback:** flag off. **Depends on:** V0.

---

## V2 — Sesión, transcript y metering

**Status:** [ ] pending

- [ ] `voice-session-manager`: sesión `channel='voice'`; persistir transcripts finales con `turn_id`.
- [ ] Migración `000NN_ai_usage_realtime_audio.sql`: agregar `realtime_audio` al CHECK de operaciones.
- [ ] Evento por sesión: provider/model/channel, segundos in/out, turn count, costo reportado/estimado; nunca transcript/audio en metadata.
- [ ] `VOICE_SESSION_MAX_MINUTES` (default 15) con aviso y cierre suave.
- [ ] Reconexión desde historia durable; no depender de la caché del proveedor.

**Evidence:** sesión visible en `/settings/ai-usage`. **Depends on:** V1.

---

## V3 — UI Talk to Gu

**Status:** [ ] pending

- [ ] Botón “Hablar con Gu”, captura y reproducción streaming; lógica fuera del componente.
- [ ] Estados: Escuchando · Entendiendo · Consultando a Gu · Listo · No pude completarlo.
- [ ] Transcript vivo en el timeline con etiqueta de voz.
- [ ] Barge-in, mute, cierre y vuelta inmediata a texto.
- [ ] Distinguir “te escuché”, “consulté” y “ejecuté”.

**Tests:** mapping estado→label. **Depends on:** V1, V2.

---

## V4 — Fast path + `ask_gu`

**Status:** [ ] pending

- [ ] Manifest manual `voice-tool-manifest.ts`.
- [ ] Fast paths read-only, tenant-scoped y registrados como ejecución determinista:
  - `search_listings(criteria)` sobre EasyBroker con integración/política vigentes;
  - `get_case_summary(case_ref)` con resolución conservadora;
  - `get_calendar(period)` con zona del perfil;
  - `get_lead_metrics(metric, period)` con 3–5 queries parametrizadas del playbook `company-data`.
- [ ] Métrica no canned → fallback automático a `ask_gu`; ninguna pregunta queda sin respuesta, solo cambia la latencia.
- [ ] `ask_gu` llama a `runConversationalTurn`: binding → pending-decision router → `runAgent({ channel: "voice" })` → resultado estructurado.
- [ ] HITL V1: voz no confirma; deja pending visible y lo explica.
- [ ] Async function calling: acknowledgment inmediato y timeout controlado.
- [ ] Persona desde Business Brain; montos con read-back; no inventar datos.

**Tests:** tenancy, integrations, fallback, pending HITL y schema. **Depends on:** V1, V2.

---

## V4.1 — Artefactos visuales y Telegram del asesor

**Status:** [ ] pending

- [ ] Resultados como tarjetas/tablas; `get_lead_metrics` produce gráfica desde el mismo resultado que la voz lee.
- [ ] Secuencia dura: generar/persistir → render/entregar → confirmar → la voz puede referenciar.
- [ ] `send_to_my_telegram(artifact_ref)` solo resuelve el Telegram verificado del propio asesor y reutiliza `notify()` / `sendTelegramDocument()`.
- [ ] Nunca alcanzar contactos externos; `telegram_send_message_to_contact` conserva risk high + HITL.
- [ ] Empezar con `tool_calls`/`structured_payload`; tabla nueva solo si no alcanza.
- [ ] Artefacto y delivery receipt son registros conceptualmente distintos.

**Tests:** entrega fallida se comunica; destino distinto del asesor se rechaza. **Depends on:** V3, V4.

---

## V5 — Evaluación y demo

**Status:** [ ] pending

- [ ] Medir TTFA, fast path vs `ask_gu`, costo, duración, interrupciones y vuelta a texto.
- [ ] Batería es-MX de nombres, direcciones, teléfonos y montos.
- [ ] Medir preguntas de leads que caen a `ask_gu` y promover las frecuentes al fast path.
- [ ] Demo: embudo con gráfica + Telegram, propiedad, caso, calendario, interrupción y fallback a texto.
- [ ] Fijar umbrales go/no-go para escritura: precisión crítica, latencia, costo y cero incidentes authz.

**Depends on:** V3, V4; V4.1 recomendado.

---

## Diferido explícito

| Etapa | Contenido | Precondición |
| --- | --- | --- |
| V6 | Acción reversible y confirmación hablada mapeada al `resumeDecision` existente. Enviar a un tercero conserva HITL; read-back de montos encima de `detectPriceApprovalAmountMismatch`. | Go de V5 |
| V6.1 | `UploadIntent`: expectativa temporal tenant-scoped para “te envío una ficha por Telegram”; matching único y compatible; ambigüedad pregunta; proximidad temporal sola nunca vincula. | V4.1 + arquitectura cross-channel |
| V7 | Migrar web y después Telegram al core compartido. | Core probado con voz |
| V8 | Telefonía saliente de seguimiento: OCR → verificar número/destinatario/propósito → HITL → llamada → resumen/caso. `lead_follow_up` ya vive aquí; atención inicial puede seguir en otro repo. WhatsApp continúa futuro. Fallback multi-provider (p. ej. OpenAI Realtime / Gemini Live) solo si se cumplen los criterios de [visión §10.4](./vision.md#104-cuándo-introducir-un-segundo-proveedor). | V6 + política de telefonía |
| Voz ↔ casos v2 | Continuar casos, decisiones y work items por voz. | Phase 2 flexible workflows |

---

## §S — Sincronización con flexible workflows

V0–V5 no dependen del work plane. Coordinar números de migración. Escrituras sobre casos v2 esperan contratos de Phase 2. El spike sí asume cerrados residual intent, price binding, metering, flags y enforcement Phase 1.

---

## Apéndice A — Core conversacional compartido

`runConversationalTurn` es la semilla del futuro `processConversationalTurn`, no una alternativa.

**Ventaja futura:** consistencia semántica, una superficie de fixes y canales nuevos baratos. El repo ya pagó el costo de dos implementaciones divergentes en el fork lab/cron documentado por el plan de workflows.

**Razón para no migrar big-bang:** web y Telegram contienen idempotencia, media groups, contactos externos, SSE y render HITL propios. Refactorizarlos antes del spike arriesga canales vivos y congela una abstracción prematura.

| Core | Adapter |
| --- | --- |
| Tenant/session/case binding | Transporte y captura |
| Pending-decision router + residual | Render HITL y estilo |
| `runAgent` | Typing, waveform, SSE |
| Persistencia y resultado estructurado | Idempotencia del transporte |

Ruta: voz crea/prueba el core → web migra → Telegram migra al final.

---

## Apéndice B — Multimodalidad

Talk to Gu habla, muestra, recibe documentos y coordina canales conservando identidad, evidencia y autoridad.

Reglas: fuente estructurada única; artefacto ≠ delivery; inbound conservador; asesor propio = bajo riesgo; tercero = HITL. El contrato canónico de turn artifacts pertenece a `docs/manuals/gu-os-cross-channel-continuity-architecture.md`. Un diseño dedicado de artifact service se escribe al agendar V6.1; una política de telefonía se escribe antes de V8.

---

## §X — Contradiction log

| # | Date | Finding | Impact | Decision |
|---|---|---|---|---|
| — | | *(append as found)* | | |

## §Y — Exit ritual

Antes de cerrar cada slice: `npm run type-check` · `npm run lint` · selftests verdes y conectados a CI · tenancy check · API-key/manifest security check · actualizar status y checkboxes.

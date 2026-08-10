# Studio: capacidades, proveedores y patrones de solución

> Estado: implementado (2026-08-08). Este documento describe las fuentes de
> verdad que usa Studio para descubrir, compilar y materializar trabajo sin
> inventar integraciones ni volver a decidir garantías ya probadas.

## 1. Flujo de autoría

1. Studio identifica por separado inputs por ejecución, canales de invocación,
   efectos externos y capacidades ejecutoras.
2. Resuelve canales/proveedores contra el snapshot real del tenant.
3. Presenta una recomendación concreta: confirmar el único conectado, elegir
   entre varios, conectar uno soportado o continuar manualmente.
4. El router propone la forma de trabajo.
5. El kernel compone el paquete base de esa forma con patrones disparados por
   efectos externos, documentos, cron, canales y esperas humanas.
6. El modelo propone `gap_candidates`; el planner determinista asigna IDs
   estables, conserva gaps previos no resueltos, ordena dependencias y
   severidades, y selecciona como máximo cuatro preguntas por turno.
7. El checkpoint (3 respuestas), hard limit (5) y uso explícito de defaults son
   blocker-aware: un gap `blocking` abierto impide preparar/materializar.
8. Los compiladores reciben `compileDirectives`; materialización persiste IDs,
   versiones, triggers y reglas de validación en provenance.
9. Un conflicto, patrón obligatorio ausente o forma de trabajo distinta bloquea
   materialización.

Fuentes de verdad:

- Catálogo de categorías/proveedores:
  `apps/web/src/lib/workflow-studio/capability-provider-catalog.ts`.
- Snapshot por tenant:
  `apps/web/src/lib/tool-readiness/load-tenant-provider-snapshot.ts`.
- Registro y composición de patrones:
  `packages/workflows/src/compiler/solution-patterns.ts`.
- Inventario y destino de aprendizajes:
  `docs/workflow-studio/pattern-coverage-matrix.md`.

## 2. Política para capacidades genéricas

- No convertir «email», «CRM» o «mensajería» directamente en una tool.
- Web/Telegram/WhatsApp como superficies de invocación no son equivalentes a
  Gmail/Telegram como destinos de un efecto externo.
- Declarar Telegram como canal de invocación no autoriza ni requiere enviar
  mensajes por Telegram. `gmail_send_email` solo se propone cuando la intención
  confirma un efecto de correo saliente; leer/procesar un adjunto no lo implica.
- Un archivo adjuntado en cada turno es `runtime_input`; `account_asset` se
  reserva para archivos reusables del tenant como plantillas o brand books.
- Si hay exactamente un proveedor conectado, proponerlo y confirmar el
  supuesto.
- Si hay varios conectados, pedir una elección concreta.
- Si ninguno está conectado pero existe adapter soportado, ofrecer conexión
  profunda desde Studio y mantener la alternativa manual.
- Un proveedor `catalog_only` o `candidate` es una recomendación evaluable, no
  una capacidad ejecutable.
- Una integración nueva sigue catálogo curado, revisión de seguridad, adapter,
  readiness y pruebas. Studio no genera ni ejecuta código arbitrario en runtime.

`transactional_email` permanece diferido: no es equivalente al correo personal
de un asesor. Requiere identidad de envío, dominio, reputación, rebotes y
políticas de volumen propias.

## 3. Adjuntos genéricos

La migración `00079_generic_attachments.sql` agrega metadata tenant-owned en
`user_files`, asociaciones canal-neutrales en `message_attachments` y el bucket
privado `user-files`. Web y Telegram comparten validación, storage, extracción,
envelope y resolución de `runtime_input`; el agente solo recibe las tools
read-only `list_runtime_attachments`, `read_runtime_attachment` y
`search_runtime_attachments`.

Formatos actuales de lectura: PDF, DOCX, PPTX, XLSX, TXT, Markdown, CSV, JSON,
XML, HTML, YAML/log y las imágenes permitidas por la política. Los contenedores
Office pasan guards ZIP antes de extracción y el texto se limita. `.xls` legacy
se rechaza explícitamente con `legacy_xls_parser_unsafe`: el parser disponible
no es seguro y el usuario debe convertir a `.xlsx`. `.doc` legacy y formatos
Office con macros tampoco están soportados.

Un adjunto conversacional permanece ligado al tenant/sesión/turno. Si el
routing resuelve un caso, se promueve al pipeline documental canónico del caso;
no se convierte en asset reusable de cuenta. `scan_status=not_scanned` no
equivale a malware-safe.

## 4. Gmail gobernado

`gmail_send_email` es una tool de riesgo alto y siempre pasa por HITL. La
confirmación muestra destinatario, asunto, preview del cuerpo, evidencia y
cantidad de adjuntos.

Contrato actual:

- OAuth mínimo: `gmail.send`.
- Envío: texto UTF-8 desde la cuenta Gmail conectada.
- Adjuntos: máximo 5; deben estar `received`, pertenecer al mismo tenant y al
  `case_id`; límite acumulado seguro de 18 MB antes del encoding MIME.
- Auditoría: una fila `tool_calls`; si hay caso, evento `state_changed` con
  `kind=email_sent`, sin guardar tokens ni contenido MIME.
- Idempotencia de turno: dos llamadas equivalentes emitidas en el mismo mensaje
  reutilizan el primer resultado y no vuelven a enviar.
- Errores de OAuth, refresh o API son fail-closed y dejan la tool como fallida.

La conexión actual **no** lee bandeja, busca mensajes ni detecta respuestas.
Estas capacidades necesitan scopes adicionales, correlación durable, webhook o
polling y una revisión separada. Discovery no debe prometerlas por inferencia.

## 5. Verificación y rollout

La simulación determinista y la ejecución con el modelo operativo son gates
distintos. El contrato de fingerprint, sandbox, juez y reparación está en
[`operational-ai-qualification.md`](operational-ai-qualification.md).
Eventos, métricas, flags pendientes, aplicación de `00079`, canary y rollback:
[`rollout-and-observability.md`](rollout-and-observability.md).

Pruebas automatizadas relevantes:

```text
packages/workflows/src/compiler/solution-patterns.selftest.ts
apps/web/src/lib/workflow-studio/capability-provider-catalog.selftest.ts
apps/web/src/lib/workflow-studio/solution-pattern-coverage.selftest.ts
apps/web/src/lib/workflow-studio/authoring-discovery.selftest.ts
packages/workflows/src/compiler/authoring-gap-planner.selftest.ts
packages/workflows/src/compiler/authoring-conversation.selftest.ts
apps/web/src/lib/attachments/attachments.selftest.ts
apps/web/src/lib/gmail/tool-executor.selftest.ts
packages/agent/src/tools/confirmation-messages.selftest.ts
apps/web/src/lib/tool-readiness/provider-readiness.selftest.ts
apps/web/src/lib/tool-readiness/tool-test-behavior.selftest.ts
```

Prueba N1 controlada para el caso «seguimiento a propietario»:

1. Conectar Gmail en Ajustes y regresar a la misma sesión de Studio.
2. Confirmar que Preparación operativa muestra `gmail_send_email` lista.
3. Usar un caso de prueba del mismo tenant con un documento `received`.
4. Preparar destinatario de prueba, asunto, cuerpo, `case_id`, evidencia y,
   opcionalmente, el ID del documento.
5. Verificar que antes de aprobar no existe envío.
6. Revisar todos los campos del preview HITL y aprobar.
7. Confirmar recepción única, nombre/tipo del adjunto, `tool_calls=executed` y
   el evento del caso.
8. Repetir con documento de otro caso, adjunto mayor al límite y OAuth revocado;
   los tres deben bloquearse sin envío.

Una prueba automática no envía correo real. El paso N1 con una cuenta y
destinatario de prueba es la evidencia E2E del proveedor externo. La regresión
determinista y el N-run live owner de authoring #1 (5/5) cubren estabilidad,
límites, blockers y separación canales/inputs/tools.

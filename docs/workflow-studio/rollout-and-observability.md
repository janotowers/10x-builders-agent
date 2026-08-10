# Studio: rollout y observabilidad

> Estado: contrato de despliegue (2026-08-09). La base de authoring, adjuntos y
> calificación está implementada, pero el rollout externo sigue condicionado a
> migraciones, telemetría y canary. La regresión determinista y el N-run live
> owner de la prueba #1 (5/5, concurrency 5) pasaron con recuperaciones
> conservadoras ante payloads truncados u omitidos del proveedor.

## 1. Alcance y fuentes persistidas

- Authoring conserva el `gap_plan` versionado, estado compacto, hash de
  confirmación e hilo en la sesión de Studio. Los gaps tienen ID estable,
  dependencias, severidad `blocking | defaultable | optional` y estado.
- `studio_qualification_runs` (migración `00077`) conserva estado, fingerprint,
  modelos, suite, rúbrica, política sandbox, latencia, tokens y costo.
  `ai_usage_events.studio_qualification_run_id` atribuye llamadas al run.
- `studio_skill_repair_proposals` (migración `00078`) conserva propuestas de
  reparación sin aplicar.
- `user_files` y `message_attachments` (migración `00079`) conservan lifecycle,
  validación, tenant, canal, turno y provenance de adjuntos. Los bytes viven en
  el bucket privado `user-files`.

`scan_status=not_scanned` no significa archivo libre de malware. La migración
`00079` no instala un scanner; la UI y la telemetría no deben presentarlo como
tal.

## 2. Eventos mínimos

Estos nombres son el contrato de instrumentación del rollout, no una afirmación
de que todos ya se emitan como eventos estructurados. Mientras se cablean, los
rollups persistidos anteriores son la fuente de verdad. Ningún evento incluye
prompt, respuesta, texto extraído, nombre de archivo, token ni argumentos de
tools.

### Authoring / gap planner

- `studio.authoring.gap_plan_built`: `session_id`, `turn_id`, versión,
  conteos por severidad/estado, preguntas seleccionadas y modelo resuelto.
- `studio.authoring.turn_resolved`: fase, número de turno, checkpoint/hard
  limit, `can_proceed`, blockers, defaults aplicados y revisiones de propuesta.
- `studio.authoring.fail_closed`: etapa, modelo y códigos de validación; debe
  distinguir `missing_gap_candidates` de errores HTTP/schema.
- `studio.authoring.draft_materialized`: tipo de artefacto, revisión y
  `confirmation_hash`; nunca contenido de negocio.

### Adjuntos

- `attachment.ingest.completed`: canal, formato, tamaño en banda, truncamiento,
  latencia de extracción, `file_id` y estado final.
- `attachment.ingest.rejected`: canal, extensión normalizada y código estable
  (`legacy_xls_parser_unsafe`, mismatch MIME, límite, macro, ZIP guard, etc.).
- `attachment.ingest.failed`: etapa (`storage | metadata | extraction |
  lifecycle`) y código sanitizado.
- `attachment.runtime.resolve_denied`: causa (`not_owned | not_ready | expired |
  envelope_mismatch`) sin revelar metadata de otro tenant.
- `attachment.case.promoted`: canal, `file_id`, `case_id` y resultado de la
  copia al pipeline documental canónico.

El rechazo de `.xls` es comportamiento esperado de seguridad, no un fallo del
servicio: se cuenta aparte y el usuario debe convertirlo a `.xlsx`.

### Calificación operacional

- `studio.qualification.started | completed`: `run_id`, tipo, fixture mode,
  fingerprint, modelos, sandbox hash, estado, latencia, tokens y costo.
- `studio.qualification.stale`: razones de drift
  (`artifact | model | scenario | rubric | sandbox | dependency`).
- `studio.qualification.tool_denied`: tool base, riesgo y sandbox hash. Cualquier
  intento de write externo es una alerta, aunque haya sido denegado.
- `studio.qualification.fixture_gate_failed`: lectura fuera de fixtures,
  marker ausente, confirmación pendiente o write externo.
- `studio.qualification.repair_proposed | non_convergent`: iteración y dueño
  clasificado del fallo; nunca cuerpo de la propuesta.

## 3. Métricas y alertas

- **Gap planner:** `fail_closed / runs` por código/modelo; preguntas p50/p95 por
  turno (máximo contractual 4); blockers al checkpoint; hard-limit bloqueado vs
  propuesta; defaults aplicados/rechazados; gaps reabiertos o re-preguntados;
  tiempo hasta confirmación/materialización.
- **Adjuntos:** aceptados/rechazados/fallidos por canal y formato; p95 de
  ingestión/extracción; truncamiento; ZIP guards; lifecycle atascado; denegaciones
  de tenancy/envelope; paridad Web/Telegram; promociones a caso.
- **Calificación:** runs por `passed | failed | stale | non_convergent`; pass
  rate por fingerprint/modelo/fixture; p95 latencia/costo; denegaciones de tool;
  writes externos observados (objetivo cero); fixture marker failures; stale age;
  iteraciones de reparación.

Alertas de parada inmediata: acceso cross-tenant exitoso, write externo durante
calificación, archivo no validado que llegue a `ready`, o materialización con
blocker abierto. `fail_closed` protege al usuario, pero una tasa elevada —en
particular sin recuperación— bloquea ampliar el canary.

## 4. Flags y compatibilidad

La convención del repositorio es `account_feature_flags` para canary por tenant
y env vars solo para kill-switch global. A fecha de este documento, estas tres
superficies no consumen todavía flags dedicados; no se debe afirmar que existe
rollback por flag hasta cablearlos. Antes del canary externo se requieren:

- `studio_authoring_gap_planner_v1`;
- `generic_attachments_v1`;
- `studio_operational_qualification_v1`.

Compatibilidad:

- Sesiones antiguas sin `gap_plan` migran en lectura a gaps `blocking`; la vista
  plana `gaps` sigue derivándose para consumidores anteriores.
- Envelopes legacy de staging se normalizan solo si su path pertenece al tenant;
  no obtienen acceso a `user_files` por inferencia.
- El pipeline documental de casos permanece canónico. Web y Telegram usan el
  pipeline genérico para el turno y promueven al pipeline del caso cuando el
  routing resuelve uno.
- `runtime_input` es por ejecución y no se convierte en `account_asset`.
  Canales de invocación, inputs y tools/efectos siguen siendo dimensiones
  separadas.
- `.xls`, `.doc` y formatos Office con macros permanecen rechazados. Soportar
  `.xlsx` no implica soportar `.xls`.

## 5. Secuencia de rollout

1. Ejecutar validadores y selftests; congelar dashboard/queries de baseline.
2. Verificar `00077` y `00078`; aplicar **`00079_generic_attachments.sql`**
   antes de habilitar uploads genéricos. Validar RLS, bucket privado, path
   `users/<user_id>/...`, límites y que no se anuncia malware scanning.
3. Cablear los flags anteriores, apagados por defecto. Desplegar código aditivo
   y comprobar que sesiones, casos y adjuntos legacy siguen funcionando.
4. Habilitar adjuntos para tenants internos: Web primero y Telegram después.
   Probar DOCX/PPTX/XLSX/TXT/CSV/PDF, mismatch MIME, ZIP guard, tamaño, tenant
   ajeno y rechazo explícito de `.xls`.
5. Habilitar calificación documental privada. Confirmar que solo
   `list_runtime_attachments`, `read_runtime_attachment` y
   `search_runtime_attachments` se autoejecutan, y que Gmail/Telegram/publicar
   quedan denegados.
6. Habilitar el gap planner para el mismo canary. Ejecutar selftests, regresión
   determinista y el live N-run owner de prueba #1
   (`npm run eval:authoring-discovery -- --conversation --runs=5 --concurrency=5`).
   Un `fail_closed` residual del proveedor debe recuperarse vía plan previo,
   question details o estado compacto; si no, bloquear la expansión del canary.
7. Observar al menos una ventana de canary con métricas por tenant/canal;
   expandir gradualmente solo sin alertas de parada.

## 6. Rollback

1. Apagar el flag de la superficie afectada (cuando esté cableado); antes de
   eso, rollback requiere revertir el despliegue.
2. Mantener `00077`–`00079` y sus filas. No hacer down-migration, borrar objetos
   privados ni reescribir fingerprints durante un incidente.
3. Volver al parser de sesiones legacy, al flujo de adjuntos/casos anterior o a
   simulación sin calificación según la superficie. Los datos nuevos quedan
   inertes y auditables.
4. Si el incidente es de extracción, detener nuevos uploads genéricos; no
   habilitar `.xls` como fallback.
5. Tras corregir, repetir los gates del canary. Cambios de artefacto/modelo/
   rúbrica/sandbox producen `stale` y exigen recalificación; no rehabilitar un
   pass anterior manualmente.

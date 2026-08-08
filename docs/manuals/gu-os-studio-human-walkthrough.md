# Studio — Walkthrough humano (checklist consolidado)

> Cierra el exit check pendiente de Phase 4 del
> [detailed implementation plan](./gu-os-flexible-workflows-detailed-implementation-plan.md):
> _"a non-engineer creates/forks, validates, simulates, and publishes a simple
> workflow that runs on a synthetic case"_. La capa de scripts
> (`apps/web/scripts/studio-walkthrough.ts`) ya pasó; esto evalúa la **UI y la
> experiencia**, no la mecánica.
>
> Consolida: (a) los aprendizajes del E2E real de `property_optioning`
> (EasyBroker + Ungga, 2026-08-05/06), y (b) la revisión de diseño A–Q con el
> usuario (2026-08-06; findings 25–26 del plan).

## 1. Principio rector

El evaluador actúa como **asistente inmobiliario sin conocimiento técnico**.
Si en cualquier punto necesita: abrir una terminal, leer la DB, conocer un
slug interno, o preguntarle a un ingeniero "¿esto es normal?" — eso es un
hallazgo, no una molestia. Se registra y se sigue.

**No basta que el flujo headless funcione; se evalúa copy, botones, estados y
recuperación visibles** (aprendizaje directo del E2E de publicación: el script
pasaba mientras la UX de retry/notificaciones tenía huecos).

## 2. Preparación (antes de tocar la UI)

- [ ] Caso sintético **`test_mode`**: el walkthrough NO involucra EasyBroker ni
      Ungga. Esa integración ya quedó probada E2E; volver a usarla contaminaría
      la evaluación del Studio con ruido de destinos externos.
- [ ] `WORKFLOW_COMPILER_MODEL_ID=anthropic/claude-opus-5` activo (decisión
      2026-08-06, finding 26): rol de juicio alto y volumen bajísimo; los gates
      deterministas siguen siendo la seguridad — el modelo fuerte mejora la
      calidad de la propuesta, no la reemplaza.
- [ ] Snapshot del catálogo de precios `2026-08-06.1` activo (el metering debe
      poder estimar el costo de las compilaciones).
- [ ] Tenant de prueba con catálogos reales (skills, tools, guards, assets)
      para que el capability map tenga contra qué resolver.
- [ ] Anotar versión/`definition_hash` de todo lo publicado ANTES de empezar
      (para verificar después que nada publicado mutó).

## 3. Estructura: dos pasadas

**Pasada 1 — Fork de un flujo existente.** Desde Catálogo: "Crear versión
propia" de `property_optioning` (o el global disponible), cambio menor,
validar, simular, publicar.

**Pasada 2 — Flujo nuevo desde lenguaje natural.** Descripción NL de un flujo
simple SIN destinos externos (p. ej. checklist documental interno). Pasa por
aclaración → specs → capacidades → gates → simulación → publicación → caso
sintético que EJECUTA.

Cada pasada recorre el checklist de la sección 4; la sección 5 agrega los
checks transversales.

## 4. Checklist por etapa

### 4.1 Catálogo

- [ ] El flujo publicado se ENCUENTRA (nombres de negocio, no slugs).
- [ ] "Crear versión propia" produce una versión **privada de la cuenta** con
      linaje visible; lo global solo lo cura el admin (decisión A).
- [ ] Versionado/fork sin duplicados y **sin mutación de la versión
      publicada**: la original queda intacta (comparar `definition_hash`
      anotado en §2).

### 4.2 Diseño — describir y aclarar

- [ ] Las preguntas de aclaración están **conversacionales y adaptativas**
      (lenguaje de negocio, 1–4 por turno, sin mostrar “ronda X de N”), con
      checkpoint interno tras 3 respuestas y extensión voluntaria hasta 5;
      no repiten lo ya respondido (O). Las preguntas abstractas muestran
      ejemplos breves y contextuales como inspiración, no como opciones
      obligatorias.
- [ ] Mientras Gu analiza, el composer no invita a escribir: se reemplaza por
      un estado visible y una acción **Detener análisis** que cancela la
      solicitud en curso.
- [ ] La transformación es VISIBLE: la descripción NL del operador se preserva
      **verbatim** en la spec de negocio y el operador puede ver ambas — su
      "What" y la interpretación del sistema — lado a lado (H). Si la
      `BusinessSpecView` actual no hace evidente esa correspondencia, es
      hallazgo de UI (ver §6).
- [ ] Frontera caso/tarea durable (B): dar a propósito un prompt "con forma de
      tarea durable" (p. ej. "analiza mi inventario cada lunes"). Hoy el Studio
      solo produce workflows de caso — lo aceptable es que lo diga o pregunte;
      lo inaceptable es publicar silenciosamente un caso fantasma. Registrar el
      comportamiento como insumo del router de Phase 5.

### 4.3 Diseño — capacidades y gaps

- [ ] Gaps **bloqueantes** (skill/tool/guard/capacidad inexistente) en rojo y
      bloquean; gaps **backlog** (asset/integración faltante) en ámbar, con
      wording en palabras del cliente ("Falta plantilla de contrato de
      comisión…") y link directo a Recursos/Integraciones (D/E).
- [ ] Distinguir a simple vista advertencia no bloqueante vs error bloqueante
      (aprendizaje E2E: esta confusión costó tiempo real).
- [ ] Subir el asset faltante y volver: el gap desaparece SIN tocar la
      definición (validación en vivo).
- [ ] Disciplina de skills (Q, finding 25): si un gap sugiere crear un skill
      nuevo, la pregunta previa es "¿el modelo + contexto ya lo hace?" — crear
      skill es la última opción, no la primera.

### 4.4 Diseño — gates, simulación y publicación

- [ ] Resultados por gate legibles (labels de negocio, no nombres internos).
- [ ] Simulación comprensible: qué camino recorrió y dónde falló, si falló.
- [ ] **Publicar** deshabilitado con gates rojos; publicar es un acto humano
      consciente y re-corre todos los gates + registra evidencia.
- [ ] Tras publicar: queda claro qué versión quedó activa y qué pasa con casos
      en curso de la versión anterior.

### 4.5 Ejecución — caso sintético

- [ ] Crear el caso `test_mode` fijado a la versión publicada, desde la UI.
- [ ] En **Trabajo durable** y **Unidades de trabajo**: labels naturales en
      todos los modos de ejecución — **cero slugs técnicos** tipo
      `registered_specialized_worker` (rename 2026-08-06, migración 00073).
- [ ] Esperas humanas (HITL): el copy de la pregunta es canónico, los botones
      responden, y web/Telegram son consistentes — la paridad viene de los
      ask-kinds registrados de la capa de notificaciones, no de copy
      por-workflow (P).
- [ ] Notificaciones obsoletas: al resolverse la causa, las notificaciones
      viejas no quedan vivas pidiendo acción.
- [ ] Cierre del caso: estado terminal claro, historial de work items completo
      y ordenado (orden por `updated_at` desc, alineado 2026-08-06).
- [ ] Recuperación visible: si algo falla, el mensaje dice qué pasó, si es
      reintentable y con qué botón — sin exigir vocabulario técnico
      (aprendizaje directo del incidente `prepare_draft`/retry de Ungga).

## 5. Checks transversales (de la revisión A–Q)

| Origen | Check |
|---|---|
| A | Todo lo creado/forkeado es privado del tenant; global = curaduría admin. |
| C | Ninguna herramienta se "inventa": tool faltante ⇒ gap bloqueante con camino governado. |
| F/G | Skills se reusan del catálogo; crear uno nuevo sigue draft→review→publish, nunca fabricación silenciosa. |
| I | Ante fallo del compilador, el loop clasifica contra el artefacto dueño (spec vs implementación vs verificación) y escala a humano en el límite de rondas. |
| J/K | Nada de código generado ejecutando en runtime; los patrones probados se generalizan como entradas de REGISTRO (guards, templates, ask-kinds), no como pseudo-código. |
| L/M | (Observación registrada, no check de esta pasada) Headless-first: vistas ricas como links firmados con retorno fácil al canal — insumo para activar §16.1. |
| N | Formato skill: `SKILL.md` + frontmatter; paridad de paquete completo es Slice 4.3 (diferido). |
| MCP | (No es check de esta pasada) MCP **no** se evalúa ni se espera como 4ª pestaña de Integraciones. Tools ≠ MCP: MCP es transporte; cuando exista, cae en Conexiones + catálogo de Tools (finding 27 / Technical Plan §28.14). |

## 6. UI: evaluar antes de construir

Pregunta abierta del usuario (2026-08-06): "¿hará falta ajustar la UI (p. ej.
caja que muestre la conversión NL → spec robusta)?" **Posición: el baseline
decide.** La `BusinessSpecView` ya muestra título/objetivo/actores/escenarios
y preserva `description_nl`; no se construye UI nueva antes de la pasada 1.

### P0 aplicado tras pasada 1 (2026-08-06)

Hallazgos de la pasada 1 de fork/publicar, cerrados antes de la pasada 2:

- [x] Diseño oculta `work_plane_soak_synthetic` por defecto (mismo filtro/toggle
      que Catálogo).
- [x] Cabeza de familia = publicada de mayor versión (no el validado/borrador);
      pins sumados en la familia; badge «vigente» en la tira de versiones.
- [x] Tras Publicar: `notice=published` → banner «Acabas de publicar la vN».
- [x] Títulos humanos en Diseño («Opcionamiento de propiedad · vN»).
- [x] Validación (en vivo) + sello corto de evidencia; sin lista duplicada.

Ajustes **candidatos** que siguen abiertos:

- Caja de correspondencia NL ↔ spec ("dijiste X → lo entendí como Y") con las
  rondas de aclaración visibles como historial.
- Diff legible entre versiones al forkar/editar.
- Wording de gaps: pasar de listado técnico a "qué te falta y dónde
  conseguirlo" con un solo CTA.
- Resumen pre-publicación tipo "estás a punto de activar X; afecta a Y".
- Limpieza/archivo de versiones huérfanas (muchas v1–v5 de pruebas).

### MCP / extensiones externas (diferido — 2026-08-07)

**No bloquea la pasada 2.** Integraciones hoy = Conexiones · Canales · Credenciales
API; Tools = catálogo governado. MCP no es “otro tipo de integración de
negocio”: es el protocolo para traer tools de un servidor externo.

Posición tomada (finding 27 del detailed plan; Technical Plan §28.14):

- No añadir pestaña MCP en Integraciones.
- Cuando se active: conectar bajo **Conexiones** (o “Servidores / extensiones”);
  materializar tools en el **catálogo de Tools** antes de que el Studio las
  componga; gaps del capability map en palabras del cliente.
- Gate: sandboxing + necesidad real (o ensanche por Phase 5 / dynamic workflows).

### Identificador de tipo / slug en Diseño (diferido — 2026-08-07)

**Hallazgo de pasada 2 (antes de compilar):** pedir `case_type` como slug
técnico al operador inmobiliario es fricción alta y fuente de basura
(`property_optioning`-style typos, nombres largos, idioma mezclado).

**Diseño acordado (implementar cuando sea oportuno; no bloquea seguir con
workaround de slug propuesto):**

1. Operador escribe **título** en lenguaje natural + **descripción**.
2. Sistema propone `case_type` en **inglés**, `snake_case`, corto (convención
   del resto del sistema: `property_optioning`, `lead_follow_up`), con
   unicidad por tenant.
3. Campo “Identificador interno (propuesto)” visible, editable, opcional.
4. Al reutilizar un tipo existente: selector con
   **Nombre amigable (`slug_tecnico`)** — p. ej. `Opcionamiento de propiedad
   (property_optioning)`.

**Pasada 2 (workaround):** título humano en la descripción; slug a pegar en
“Tipo de caso” = `property_visit_coordination`.

### Correcciones post-pasada 2 (implementadas)

Hallazgos de Pasada 2 ya corregidos en código (finding 30):

- **Router antes de compile** — clasifica NL → artefacto (`case_workflow` /
  `durable_task` / `reusable_skill` / `schedule` / `clarify` /
  `redirect_to_chat`) antes de invocar el compilador de casos.
- **Streaming de progreso** — etapas visibles durante autoría/compilación
  (API de progreso por etapas).
- **Título + slug** — el operador escribe título NL; el sistema propone slug
  en inglés `snake_case` (ya no solo `case_type` crudo).
- **Taxonomía `input_requirements`** — separa prerrequisitos de cuenta
  (`account_assets`) de datos de runtime; evita clasificar mal
  `required_assets`.
- **Simulación** — BFS ancla en terminales de éxito (no elige `cancelled`
  como terminal feliz); parity de proposers.
- **Reiniciar `next dev`** tras cambiar `WORKFLOW_COMPILER_MODEL_ID` — el
  proceso Node no recarga ese env en caliente.
- **Batería #1** — “skill simple reusable” debe rutear a
  `reusable_skill/simple` (ya no a case workflow).

### Hallazgo de batería #1 — discovery y revisión de borrador

**Implementado en código (finding 31, 2026-08-07); repetición manual #1/#2
pendiente tras aplicar migración `00076`.**
La clasificación correcta no prueba que la solicitud esté completa. En
“Seguimiento cordial a propietarios”, Studio reconoció
`reusable_skill/simple`, pero materializó sin preguntar de dónde leer el
historial/último acuerdo: produjo `requires_tenant_context:true` con
`allowed_tools:[]`. Además redirigió directamente al editor raw de Skills de
cuenta.

La solución **no** es un catálogo determinístico de preguntas ni una nueva
doctrina paralela. Las fuentes ya existen:

- `skills/global/skill-authoring/SKILL.md` + referencias: contrato ejecutable
  de autoría, discovery, MECE, tools, tenant context, HITL, rúbrica y
  activación;
- `docs/operational-cases/use-case-authoring-vision.md`: discovery → propuesta
  → revisión humana → readiness proporcional → activación controlada;
- Technical Plan §3.1/§7.0/§9/§14–17: human involvement, case vs durable task,
  modelos, lifecycle y publicación;
- `docs/skills-tools-architecture.md`: juicio/skill vs ejecución/tool/código y
  Skill Lab.

Contrato de UX esperado antes de reanudar la batería:

1. La primera acción dice **Analizar solicitud**, no crea todavía.
2. Discovery model-backed usa la doctrina, catálogos reales y estado compacto
   del transcript; puede corregir la forma de trabajo provisional. El
   clasificador determinístico es solo señal/fallback interno (no se muestra
   como chip al operador).
3. Conversación tipo chat: Gu hace 1–4 preguntas materiales por turno; la
   persona responde en un composer único. Tras 3 respuestas hay checkpoint
   (“Seguir aclarando” / “Preparar propuesta”); el hard limit es 5. No
   pregunta “¿quieres HITL/botón?”, sino quién decide y qué necesita ver.
4. El modelo cita qué texto/respuesta cubre cada dimensión. Código
   determinístico valida schema, límites, evidencia existente, tenancy,
   catálogo, side effects y autoridad; no pretende decidir suficiencia
   semántica con regex.
5. Muestra **Esto entendí** y solo entonces la **Forma propuesta** (skill,
   caso, tarea durable o programación), junto con supuestos y gaps.
6. Solo **Crear borrador** materializa tras confirmación humana.
7. Los cuatro tipos aterrizan en una revisión común dentro de Diseño; el
   editor técnico de Ajustes se abre como acción posterior explícita.
8. Progreso humano en el hilo; provenance técnica bajo “Ver detalles”.

Evidencia automatizada:

- contrato Zod + citas de evidencia + selftests;
- type-check web/workflows/db y suite `test:workflow-studio`;
- validadores de skills/migraciones;
- batería live #1–#10 con `anthropic/claude-opus-5`: los diez destinos
  conservaron la taxonomía esperada; #1/#2 pidieron aclaraciones materiales;
- compilación live de `owner-followup-message`: SKILL.md válido, tenant-aware y
  dos tools reales del catálogo, sin persistir el artefacto durante el eval.

### Taxonomía del router de autoría (corregida — 2026-08-07)

El Studio **crea artefactos governados**; no es la superficie para ejecutar
consultas puntuales. El anterior `one_shot_skill` de Slice 5.3 no tenía
definición y se retiró por ambiguo (finding 29).

**Artefactos:**

- `case_workflow`
- `durable_task`
- `reusable_skill`, subtipo `simple | composite`
- `schedule` (programa/referencia trabajo subyacente)

**Resultados sin artefacto:**

- `clarify`
- `redirect_to_chat` (la intención es ejecutar algo una vez)

Un `capability_gap` es diagnóstico posterior de compilación/readiness, no un
tipo de artefacto.

### Batería inmobiliaria del router / compilador

1. **Skill simple reusable:** “Cada vez que prepares un seguimiento para un
   propietario, resume el último acuerdo y termina proponiendo una siguiente
   acción concreta; nunca inventes compromisos ni fechas.”
   Esperado: clasificación provisional `reusable_skill/simple`; discovery
   pregunta dónde vive el último acuerdo/historial (y cualquier otra
   ambigüedad material), no pregunta si debe enviar porque “preparar” ya
   implica draft-only; resumen `Esto entendí`; creación solo tras confirmar.
2. **Skill compuesto:** “Antes de una cita de captación, prepara una carpeta
   con datos de la propiedad, zona, comparables, pendientes, antecedentes del
   propietario y agenda sugerida.”
   Esperado: `reusable_skill/composite`; discovery revisa fuentes, overlap y
   composición contra skills/tools existentes antes de proponer includes.
3. **Caso operacional — pasada 2 actual:** “Coordinación de visita a
   propiedad”: prospecto solicita visita → reunir datos → obtener horarios →
   aprobación del asesor → coordinar/confirmar → recordar → registrar
   realizada/reprogramada/cancelada/no-show. No inventar disponibilidad ni
   contactos.
   Esperado: `case_workflow`; slug temporal `property_visit_coordination`.
4. **Caso de arrendamiento:** reunir expediente del solicitante, identificar
   faltantes y pedir decisión al asesor/propietario; Gu no aprueba/rechaza
   automáticamente.
   Esperado: `case_workflow` con HITL obligatorio.
5. **Tarea durable batch:** analizar 300 propiedades activas y producir reporte
   de posibles subvaluadas, incompletas, duplicadas y prioritarias.
   Esperado: `durable_task`, sin 300 casos fantasma.
6. **Tarea durable documental:** revisar expedientes de propiedades activas,
   detectar documentos faltantes/vencidos y reportar por asesor.
   Esperado: `durable_task`.
7. **Programada:** cada lunes 08:00 revisar leads sin actividad en siete días y
   entregar a cada asesor una lista priorizada.
   Esperado: `schedule` sobre una tarea durable.
8. **Integración faltante:** sincronizar leads de portales con “nuestro CRM” y
   evitar duplicados.
   Esperado: `clarify` qué CRM; luego gap de conexión/tool si no existe. Nunca
   inventar adapter o tool MCP.
9. **Ambigua:** “Ayúdame a mejorar el seguimiento de mis prospectos.”
   Esperado: `clarify` objetivo, volumen, recurrencia, canales y responsables.
10. **Consulta puntual en la superficie equivocada:** “Con estos datos,
    redacta la descripción de esta propiedad.”
    Esperado: `redirect_to_chat`; no crear skill ni workflow.

## 7. Registro de hallazgos y salida

Cada hallazgo: **(etapa, qué esperaba el evaluador, qué pasó, severidad
bloqueante/fricción/cosmética)**. Al terminar:

1. Corregir/documentar hallazgos (paso 3 del orden acordado).
2. Marcar el exit check de Phase 4 en el detailed plan.
3. Decidir el pendiente del retiro total del authoring del lab: ¿falta paridad
   real en el Studio o se difiere explícitamente?
4. Solo entonces, iniciar Phase 5 (Durable Work Roots), alimentada con lo
   observado en el check de frontera B (§4.2).

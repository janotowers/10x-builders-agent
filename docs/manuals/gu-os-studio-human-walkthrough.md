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

- [ ] Las preguntas de aclaración están en **lenguaje de negocio**, acotadas
      (≤3 rondas, ≤5 preguntas por ronda), y no repiten lo ya respondido (O).
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

## 7. Registro de hallazgos y salida

Cada hallazgo: **(etapa, qué esperaba el evaluador, qué pasó, severidad
bloqueante/fricción/cosmética)**. Al terminar:

1. Corregir/documentar hallazgos (paso 3 del orden acordado).
2. Marcar el exit check de Phase 4 en el detailed plan.
3. Decidir el pendiente del retiro total del authoring del lab: ¿falta paridad
   real en el Studio o se difiere explícitamente?
4. Solo entonces, iniciar Phase 5 (Durable Work Roots), alimentada con lo
   observado en el check de frontera B (§4.2).

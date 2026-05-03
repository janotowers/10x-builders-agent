# Propuesta — Endurecer EXTRACTION_SYSTEM_PROMPT (revisión previa)

**Estado**: borrador para revisión. NO aplicado al código todavía.

**Archivo objetivo**: `packages/agent/src/memory_flush.ts`, constante
`EXTRACTION_SYSTEM_PROMPT`.

**Motivación**: ver `docs/memory/memory_curation_plan.md` § "Diagnóstico
(sesión 2026-05-02)". Resumen: Haiku está extrayendo como `semantic`
afirmaciones que técnicamente vienen del usuario pero son **inputs a una
tarea transaccional** (ej. el nombre/teléfono de un lead que el usuario
mencionó para que el agente le redactara un WhatsApp). Eso luego se
inyecta en turnos posteriores como si fuera un hecho durable sobre el
usuario.

## Cambios propuestos al prompt

### 1) Insertar dos reglas nuevas (5 y 6) y renumerar las existentes

Las actuales 5/6/7 pasan a 7/8/9. La numeración importa porque el modelo
las cita internamente.

**Reglas nuevas**:

```text
5. NO EXTRAIGAS información sobre TERCEROS DE NEGOCIO que aparezca como
   input a una tarea transaccional. Específicamente:
   - Nombres, teléfonos, emails o IDs de leads, prospectos, clientes,
     asistentes a citas o contrapartes de un deal.
   - Direcciones, precios, IDs o atributos de propiedades, inventario,
     catálogo o eventos de negocio.
   - Contenido de mensajes que el usuario está componiendo o pidiendo
     redactar (WhatsApps, emails, drafts).
   - Estados de pipeline (etapas, fechas de seguimiento, montos por cerrar).
   Estas entidades viven en sistemas externos (CRM, BigQuery, calendario)
   y el agente las consulta con tools cuando las necesita. Guardarlas en
   memoria larga las congela en el tiempo y contamina futuros turnos.
   EXCEPCIÓN: contactos personales estables (familia, amistades, médico,
   contador) que el usuario comparte deliberadamente como contexto, no
   como input a una tarea operativa. Test rápido: si la frase tiene la
   forma "el lead/cliente/propiedad X tiene Y" o "su nombre/tel/email es
   Z" como respuesta a una pregunta del agente, NO la extraigas.

6. NO EXTRAIGAS INPUTS DE TAREA. Si el [assistant] inmediato anterior
   le pidió al usuario un dato concreto (nombre, teléfono, fecha,
   dirección, monto, hora) y el [user] solo respondió con ese valor,
   ese intercambio es un PARÁMETRO DE UN TURNO, no un hecho durable
   sobre el usuario. NO lo extraigas, ni siquiera si la frase del
   usuario está bien formada ("su nombre es X", "el teléfono es 521…").
```

### 2) Reemplazar/expandir la sección de FORMATO con ejemplos negativos

Justo antes del bloque `FORMATO:` actual, añadir:

```text
EJEMPLOS DE QUÉ EXTRAER Y QUÉ NO (dominio inmobiliario):

SÍ extraer:
- "El usuario es asesor inmobiliario en Mazatlán" (rol durable).
- "Prefiere mensajes de WhatsApp en tono amigable y firma 'Saludos, Juan'"
  (preferencia procedural).
- "Su contadora se llama Lucía Pérez, contacto +52 33 1234 5678"
  (contacto personal estable).

NO extraer (Regla 5 — datos transaccionales):
- "El lead Julieta Evelia tiene teléfono 521…"
- "La propiedad de la calle Reforma 123 está en venta a 4.5M"
- "El cliente Pedro pidió cita para el viernes"

NO extraer (Regla 6 — input de tarea):
[assistant] Para personalizarlo necesito el nombre del lead, ¿cuál es?
[user] El nombre es Julieta Evelia
→ extracted = []   (es un parámetro, no un hecho)
```

## Cambios mecánicos (no de prompt)

### Selftest nuevo

Crear `packages/agent/src/memory_flush.selftest.ts` (si no existe ya
en otra forma) o ampliar el actual con tres casos en una función
`runHardeningSelftests()`:

| Caso | Transcript clave | Esperado |
|---|---|---|
| `lead_name_as_input` | `[assistant] ¿cuál es el nombre del lead?` + `[user] Julieta Evelia` | `extracted === 0` o ningún item con `Julieta` |
| `crm_data_volunteered` | `[user] Necesito un WhatsApp para María, vive en Reforma 123 y le interesa la casa de 5M` | 0 items con `María`, `Reforma 123`, `5M` |
| `genuine_preference` | `[user] siempre prefiero que respondas en bullets en español neutro` | ≥ 1 item de tipo `procedural` |
| `personal_contact` | `[user] mi hermana Ana cumple 15 marzo, recuérdamelo cada año` | ≥ 1 item de tipo `semantic` con "hermana" o "Ana" |

Implementación: usar el extractor real con un mock del LLM
(o, si es muy costoso, llamar a Haiku una sola vez por caso bajo flag
`MEMORY_FLUSH_SELFTEST_LIVE=1`).

### Métrica de monitoreo

Añadir un log cuantitativo en `memory_flush.ts` cuando se guarde un
item: si su `content` matchea regex de "datos sospechosos" (teléfonos
≥ 8 dígitos, frase exacta `el nombre es`, `el lead`, `la propiedad`),
loguear con nivel `warn` y campo `suspect: true` en `logMemoryFlush`.
Esto NO bloquea la inserción (decisión final del modelo), pero permite
auditar la efectividad del prompt sin romper nada.

## Riesgos y limitaciones

1. **Falsos negativos**: el prompt podría volverse demasiado estricto y
   dejar de extraer preferencias genuinas. Mitigación: la sección de
   ejemplos positivos refuerza qué SÍ extraer; los selftests del caso
   `genuine_preference` y `personal_contact` la blindan.
2. **Prompt creep**: el system prompt ya es largo; añadir ~20 líneas más
   sube el coste por flush. Mitigación: el flush corre con Haiku y
   ocurre 1 vez por sesión post-turno; el coste marginal es despreciable
   vs. el daño de memorias falsas.
3. **Haiku sigue siendo ruidoso**: aun con prompt mejorado, el modelo
   puede seguir extrayendo cosas raras. Por eso la Capa 1 incluye un
   segundo paso (veto por skill) y por eso la Capa 2 (curación UI/skill)
   es necesaria como red de seguridad.

## Próximos pasos sugeridos

1. ✅ Documento revisado por usuario.
2. Aplicar el patch al `EXTRACTION_SYSTEM_PROMPT` y agregar selftests.
3. Correr `npm run test:memory-flush` (a crear si no existe) y
   `npm run type-check`.
4. Probar en sesión real con `lead-follow-up-draft`: verificar que el
   siguiente flush no guarda nada del lead.
5. Si tras ~1 semana de uso real sigue colándose ruido, evaluar el
   "veto por skill" descrito en la Capa 1 del plan de curación.

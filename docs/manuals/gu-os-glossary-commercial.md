# Gu OS — Glosario comercial (una página)

> **Audiencia:** ventas, alianzas, producto, onboarding de clientes  
> **No sustituye:** [`gu-os-understanding.md`](gu-os-understanding.md) (guía completa) ni [`architecture-manual.md`](architecture-manual.md) (técnico)  
> **Versión:** 2026-06 — alineado con skills V1, `account_skills` V1, casos operacionales y Brain Layer en roadmap

---

## En una frase

**Gu OS** es un asistente operativo para inmobiliarios: conversa contigo, consulta tus datos, sigue procedimientos definidos, pide tu OK en acciones sensibles y puede vigilar pendientes en segundo plano — con trazabilidad y permisos, no como un chat genérico.

---

## Términos esenciales

| Término | Qué significa para el cliente |
|---------|-------------------------------|
| **Gu OS** | La capa de inteligencia y ejecución sobre la operación inmobiliaria (chat, Telegram, automatizaciones). Parte del ecosistema Ungga. |
| **Asistente / agente** | El motor que interpreta mensajes, elige procedimientos y usa herramientas. No es “solo ChatGPT”: está acotado por reglas del producto. |
| **Skill (recetario)** | Manual de procedimiento en lenguaje natural: *cuándo* aplica y *cómo* debe actuar el asistente (tono, pasos, qué pedir antes de ejecutar). |
| **Tool (herramienta)** | Acción concreta y acotada: consultar métricas, listar calendario, crear un caso, enviar un mensaje. La skill ordena; la tool ejecuta. |
| **Catálogo global de skills** | Recetarios que vienen con el producto (actualizados con el software). El usuario puede activar o desactivar los suyos. |
| **Skill propia (`account_skills`)** | Recetario personalizado por cuenta (texto editable en Ajustes). Si comparte nombre con uno global, **gana la versión de la cuenta**. |
| **`scope` (business / personal / shared)** | Etiqueta de *tipo de trabajo*: negocio inmobiliario, vida personal del usuario, o ambos. No significa “público para todos”. |
| **Business Brain** | Ficha de la cuenta: nombre de la inmobiliaria, tono, contexto estable y enlace al warehouse (`organization_id`). Alimenta skills de negocio. |
| **Memoria personal** | Preferencias y datos sobre **ti** (estilo, rutinas, contactos personales relevantes). No sustituye al CRM ni al inventario. |
| **Warehouse (BigQuery)** | Copia analítica de leads, propiedades, mensajes, deals, etc. Fuente de verdad **tabular** para preguntas de negocio. |
| **Brain Layer (roadmap)** | Memoria **operacional del negocio** futura: entidades (lead, propiedad…), historial, relaciones y señales — con revisión humana antes de promover hechos. |
| **HITL (aprobación humana)** | “Human in the loop”: antes de acciones sensibles (publicar, contratos, comandos riesgosos) el sistema **pide tu confirmación** en web o Telegram. |
| **Tarea programada** | “Haz *esto* a *esta hora*” (o recurrente). Tú apruebas al crearla; cuando suena, puede ejecutar sin que estés en línea. |
| **Heartbeat (pulso)** | Revisión periódica según **lista de chequeo** (reuniones, pendientes, alertas). Más conservador que una tarea libre; enfoque lectura y aviso. |
| **Caso operacional** | Expediente de varios días/semanas (ej. captar una propiedad): pasos, esperas del dueño, documentos, precio, contrato. El sistema lo retoma solo. |
| **Tenant / `organization_id`** | Aislamiento de datos por inmobiliaria en consultas de negocio. El asistente no mezcla métricas de un cliente con otro. |
| **Canal** | Dónde ocurre la interacción: web, Telegram, cron (automatización), heartbeat, runner de casos. |
| **Autonomía gobernada** | El sistema puede avanzar trabajo solo **dentro de reglas**, permisos y aprobaciones — no “hace lo que quiera”. |
| **Thin harness, fat skills** | Filosofía de diseño: poca lógica en el motor central; el valor está en **recetarios bien escritos** y ejecución determinística abajo. |
| **Preparación operativa (N0–N5)** | Laboratorio en Ajustes para **casos** multi-día: credenciales, tools, habilidades, pasos y recorrido E2E controlado antes de activar. |
| **Skill Lab** | Checklist más ligero para **skills de un turno** (sin esperas multi-día): rúbrica, evals, prueba de integraciones — no sustituye N0–N5. |
| **Quality bar** | Evidencia mínima antes de activar (evals, N3/N4, recorrido E2E o corridas reales documentadas) — proporcional al riesgo. |

---

## Tres preguntas que suelen hacer en demo

**¿Es un chatbot más?**  
No solo. Es chat + procedimientos + datos del negocio + herramientas + aprobaciones + automatizaciones en segundo plano.

**¿Inventa números de leads o propiedades?**  
En skills de datos está diseñado para consultar el warehouse real. Si no hay conexión, debe decirlo — no rellenar con suposiciones.

**¿Puede mandar un contrato o publicar sin que yo lo vea?**  
Las acciones sensibles pasan por **HITL**. Los recetarios de captación y publicación lo exigen explícitamente.

---

## Qué NO es Gu OS (para alinear expectativas)

| No es | Por qué importa decirlo |
|-------|-------------------------|
| Wiki personal tipo Obsidian | Optimizamos **operación** (cerrar deals, no perder leads), no jardín de notas. |
| Reemplazo del CRM | Consulta y actúa sobre datos; el warehouse y sistemas operativos siguen siendo la base tabular. |
| Agente 100 % autónomo | Priorizamos control, trazabilidad y aprobación humana en acciones de impacto. |
| Marketplace de plugins abiertos | Skills y integraciones pasan por gates de permiso y revisión del producto. |

---

## Dónde profundizar

| Rol | Documento |
|-----|-----------|
| Entender el sistema (narrativa) | [`gu-os-understanding.md`](gu-os-understanding.md) |
| Presentación negocio / capas | [`gu-os-business-architecture-view.md`](gu-os-business-architecture-view.md) |
| Principios agenticos (GStack) | [`agentic-principles-alignment.md`](agentic-principles-alignment.md) |
| Casos operacionales (captación) | [`../operational-cases/architecture.md`](../operational-cases/architecture.md) |
| Roadmap producto | [`../business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md) |

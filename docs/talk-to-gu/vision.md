# Talk to Gu — Visión de producto y arquitectura

**Status:** dirección canónica de producto; las capacidades descritas se entregan por etapas y no implican que ya existan.

**Audiencia:** producto, diseño, ingeniería, operaciones y liderazgo comercial.

**Documentos relacionados:** [plan de implementación de voz](./realtime-voice-implementation-plan.md) · [continuidad cross-channel](../manuals/gu-os-cross-channel-continuity-architecture.md) · [arquitectura general](../architecture.md) · [flexible workflows](../manuals/gu-os-flexible-workflows-architecture-analysis.md).

---

## 1. Visión

**Talk to Gu es la interfaz operacional multimodal de Gu OS para el profesional inmobiliario.**

El usuario puede hablar, mirar, enviar documentos y aprobar acciones mientras Gu coordina datos, canales, workflows y personas bajo identidad, políticas, evidencia y autoridad compartidas.

No buscamos un voicebot ni un chat con micrófono. Buscamos que Gu acompañe el trabajo diario con la modalidad más adecuada para cada momento:

- **voz** para preguntar, dictar, interrumpir y trabajar con las manos ocupadas;
- **visual** para comparar, revisar evidencia y decidir;
- **documentos e imágenes** para capturar y entregar información;
- **mensajería y telefonía** para coordinar con asesores, propietarios e interesados;
- **casos y workflows** para conservar continuidad y ejecutar de forma gobernada.

La promesa comercial es:

> Habla con Gu como con un colaborador, pero opera con la trazabilidad y los controles de un sistema.

---

## 2. Problema que resolvemos

El trabajo inmobiliario en México y Latinoamérica ocurre fragmentado entre conversaciones, CRM, portales, calendarios, llamadas, fotografías, PDFs, hojas de cálculo y mensajería. El asesor frecuentemente:

- trabaja desde el automóvil o durante una visita;
- recibe información incompleta por WhatsApp o Telegram;
- necesita comparar propiedades y cifras antes de decidir;
- cambia entre web, teléfono y mensajería;
- debe dar seguimiento sin perder contexto;
- coordina a propietarios, interesados y colaboradores;
- realiza acciones sensibles — precio, contrato, publicación, contacto externo — que requieren confirmación.

Una interfaz exclusivamente textual obliga al usuario a traducir ese trabajo multimodal a comandos. Una interfaz exclusivamente auditiva oculta evidencia y dificulta revisar tablas, fotografías, cifras y documentos. Talk to Gu une ambos mundos sin convertir al modelo de voz en autoridad operacional.

---

## 3. Principios de producto

1. **Voice-first cuando hablar sea natural; visual-first cuando verificar sea importante.**
2. **Una respuesta puede ser hablada, visual y accionable a la vez.** No todas requieren los tres componentes.
3. **Gu muestra evidencia antes de pedir decisiones críticas.**
4. **Escuchar no significa entender; entender no significa ejecutar.** La UI y la voz distinguen cada estado.
5. **Una sola fuente para voz y visuales.** Las cifras habladas y la gráfica derivan del mismo resultado estructurado.
6. **El proveedor de voz es la boca; Gu OS conserva el cerebro.** Skills, tools, políticas, casos y workflows no se duplican en el proveedor.
7. **Cambiar de canal no amplía permisos.**
8. **La sesión es efímera; el trabajo es durable.** Casos, artefactos, decisiones, evidencia y resultados sobreviven a desconexiones.
9. **Artefacto no equivale a entrega.** Gu solo dice “te lo envié” después de confirmar el delivery.
10. **Asociación conservadora.** Un archivo o mensaje ambiguo nunca se vincula silenciosamente al caso o turno equivocado.
11. **Efectos externos proporcionales al riesgo.** Consultar es distinto de publicar, enviar o llamar.
12. **El usuario siempre puede volver a texto o tomar control.**

---

## 4. Modelo de experiencia multimodal

Un turno puede producir una composición:

```text
Respuesta hablada
+ artefacto visual
+ evidencia y procedencia
+ acción propuesta
+ decisión pendiente
+ recibo de entrega
```

Ejemplo:

```text
Usuario: “¿Cómo estuvo mi embudo el mes pasado?”

Gu habla:
“Recibiste 84 leads. Diecinueve llegaron a visita y cuatro avanzaron
a negociación. La principal caída estuvo antes de agendar visita.”

Gu muestra:
Gráfica del embudo + comparación contra el periodo anterior.

Gu propone:
“Puedo prepararte la lista de los 23 leads sin seguimiento.”

Gu entrega, si se solicita:
PNG/PDF al Telegram verificado del asesor, con delivery confirmado.
```

La voz nunca describe como existente un artefacto que todavía no fue generado o mostrado.

---

## 5. Jornadas inmobiliarias prioritarias

### 5.1 Briefing del día

> “Gu, ¿cómo amaneció mi operación?”

Gu resume leads nuevos, seguimientos vencidos, visitas, propiedades detenidas, documentos pendientes y decisiones por aprobar. En pantalla muestra prioridades y, si el usuario lo pide, envía un resumen a Telegram.

### 5.2 Embudo y desempeño comercial

> “¿Cómo cerró mi embudo el mes pasado y dónde estoy perdiendo leads?”

Gu consulta datos gobernados, explica tasas de conversión y muestra embudo, evolución y fuentes. El usuario puede continuar:

> “Enséñame los que se quedaron antes de visita y sepáralos por asesor.”

Los conjuntos dinámicos se conservan como artefactos acotados con procedencia, no como memoria personal.

### 5.3 Seguimiento de leads

> “¿Qué leads de esta semana todavía no tienen visita?”

Gu muestra la lista y explica prioridades. Puede preparar mensajes o proponer llamadas:

> “Prepara seguimiento para los primeros tres y programa que mañana les marquemos.”

Los borradores pueden generarse inmediatamente; los envíos y llamadas externas requieren confirmación y auditoría.

### 5.4 Captación de propiedad desde una ficha

> “Te voy a enviar por Telegram la ficha que me dio el propietario.”

Gu abre una expectativa temporal, recibe el archivo del mismo usuario verificado, extrae dirección, teléfono y características, muestra lo detectado y solicita correcciones o faltantes antes de incorporarlo al caso.

Si hay más de una expectativa o propiedad compatible, Gu pregunta; nunca asocia solo por cercanía temporal.

### 5.5 Trabajo en campo

Durante un recorrido:

> “Anota humedad en la recámara secundaria, dos estacionamientos y que la escritura llega mañana.”

Gu registra observaciones como claims atribuibles, distingue hechos confirmados de pendientes y muestra después un resumen para revisión. Fotografías dictadas o enviadas se vinculan al caso correcto mediante referencias estructurales.

### 5.6 Comparables y recomendación de precio

> “Compara esta casa con propiedades activas en la zona y dime si 6.2 millones es defendible.”

Gu presenta tabla o mapa de comparables, metodología, dispersión y propuesta de salida/ideal. La explicación hablada usa los mismos datos. La aprobación de precio queda ligada a la evidencia vigente y se suspende si cambian inputs materiales.

### 5.7 Preparación de ficha y publicación

> “¿Ya está lista la propiedad de Las Fuentes?”

Gu explica faltantes, muestra ficha, fotografías y paquete. Puede enviar la ficha al propio asesor con bajo riesgo. Enviarla a un interesado o publicarla es un efecto externo y requiere HITL.

### 5.8 Agenda, visitas y rutas

> “Encuentra horarios para visitar estas tres propiedades el sábado.”

Gu conversa sobre disponibilidad mientras muestra calendario y propiedades. Puede proponer una secuencia; la creación de citas ocurre solo después de confirmación.

### 5.9 Revisión de documentos

Gu puede recibir y clasificar identificación, escritura, predial, ficha técnica, contrato, fotografías y comprobantes. Extrae datos, señala incertidumbre y solicita validación cuando el documento tiene efectos legales o comerciales.

### 5.10 Llamadas de seguimiento

> “Marca al interesado de la visita de ayer y averigua qué objeciones tuvo.”

Gu resuelve de forma conservadora lead, visita, número y propósito; muestra y lee el destinatario antes de confirmar. Tras autorización, un agente telefónico realiza la llamada bajo política de aviso/consentimiento y devuelve resumen, interés, objeciones y siguiente acción.

El seguimiento puede pertenecer a este repositorio: aquí ya existe el workflow `lead_follow_up`. La atención inicial de leads puede permanecer en otro sistema y entregar el caso mediante un contrato gobernado.

---

## 6. Actores y fronteras

### Usuario interno

Asesor, coordinador u operador autenticado. Puede consultar su información y aprobar acciones dentro de sus permisos.

### Contactos externos

Propietarios, interesados y otros brokers. Sus mensajes son input no confiable; no comparten identidad ni permisos con el usuario interno.

### Canales

- Web: experiencia visual principal y voz interna.
- Telegram: canal actual para notificaciones, documentos y algunos contactos.
- WhatsApp: canal futuro; requiere integración oficial y políticas propias.
- Telefonía: canal futuro para seguimiento gobernado.

La identidad del usuario, el caso y la decisión son más fuertes que la sesión o el canal.

---

## 7. Arquitectura objetivo

```text
Web voice · Web UI · Telegram · WhatsApp · Phone
                       │
             Channel / media adapters
                       │
        Shared conversational-turn core
        gates · routing · residual · HITL
                       │
          Multimodal artifact service
     create · render · bind · deliver · resolve
                       │
          Gu OS governed execution
  Agent · Skills · Tools · Cases · Work · Policies
                       │
       Facts · Evidence · Artifacts · Approvals
                       │
 CRM · BigQuery · Calendar · Portals · Telephony
```

### Responsabilidades

- **Proveedor realtime:** audio, VAD, interrupción, prosodia y lectura.
- **Conversational core:** identidad, routing, decisiones, invocación de Gu y resultado estructurado.
- **Artifact service:** contenido, procedencia, binding, render y receipts.
- **Gu OS:** autoridad, memoria durable, políticas, permisos y efectos.
- **Workflows:** transición legal, trabajo, verificación e impacto.
- **Adapters de canal:** captura, render y delivery; no semántica de negocio duplicada.

---

## 8. Etapas de evolución

### Etapa 1 — Talk to Gu interno

Voz web autenticada, transcript, interrupciones, consultas read-only, resultados visuales y fallback a texto.

### Etapa 2 — Entrega multimodal

Gráficas, tablas y documentos inline; envío al Telegram verificado del asesor con recibo.

### Etapa 3 — Recepción correlacionada

`UploadIntent` para documentos enviados durante una conversación; asociación tenant-scoped, temporal y conservadora.

### Etapa 4 — Acciones gobernadas por voz

Acciones reversibles, read-back de datos críticos y confirmación hablada mapeada al HITL existente.

### Etapa 5 — Seguimiento externo

Envíos a interesados/propietarios y llamadas salientes dentro de casos/workflows; resumen y siguiente acción durables.

### Etapa 6 — Omnicanal medido

WhatsApp, telefonía más amplia, antecedent resolver y multi-provider donde exista evidencia de necesidad (ver §10). No implica un transcript universal.

---

## 9. Métricas de éxito

### Experiencia

- tiempo a primer audio;
- latencia hasta resultado visual;
- interrupciones manejadas correctamente;
- precisión en nombres, direcciones, teléfonos y montos;
- tasa de cambio a texto;
- correcciones posteriores a transcripción.

### Resultado de negocio

- tiempo ahorrado por briefing/consulta;
- leads recuperados para seguimiento;
- reducción de casos detenidos;
- tiempo de captación a paquete listo;
- tasa de aceptación de acciones propuestas;
- trabajo completado sin reingreso manual de datos.

### Confianza y gobernanza

- cero efectos externos sin autorización;
- cero asociaciones cross-tenant;
- entregas afirmadas vs receipts reales;
- clarificaciones por ambigüedad;
- decisiones ligadas a evidencia vigente;
- costo por sesión y por resultado útil.

---

## 10. Proveedores de voz: primera opción y alternativas

La primera implementación usa **Grok Voice Think Fast 2.0** (`grok-voice-think-fast-2.0`) detrás de una interfaz de proveedor (`RealtimeVoiceProvider`). Eso no implica exclusividad: el contrato existe precisamente para poder comparar o cambiar de proveedor sin reescribir Gu OS.

### 10.1 Benchmark de referencia (Artificial Analysis, julio 2026)

| Métrica | Grok Voice Think Fast 2.0 | Grok Voice Think Fast 1.0 | GPT-Realtime-2.1 (High) | Gemini 3.1 Flash (High) |
| --- | ---: | ---: | ---: | ---: |
| Overall (AA Speech-to-Speech Quality Index) | **82.9%** | 75.7% | 79.1% | 69.5% |
| Speech Reasoning (Big Bench Audio) | **97.2%** | 97.1% | 96.0% | 96.6% |
| Conversational Dynamics (Full Duplex Bench) | 95.1% | 77.8% | **95.7%** | 74.3% |
| Agentic Performance (τ-voice Bench) | **56.5%** | 52.1% | 45.7% | 37.7% |
| Speed (Time to First Audio) | **0.70s** | 1.25s | — | 2.98s |

Fuente: Artificial Analysis, publicada junto al anuncio de Think Fast 2.0. Los números son snapshot externo; V0/V5 deben revalidar calidad real en es-MX (nombres, colonias, montos) y costo vigente.

### 10.2 Por qué Grok Voice Think Fast 2.0 es la primera opción

- Mejor índice overall y latencia a primer audio entre los comparados.
- Mejor desempeño agentic relativo (56.5%) — relevante aunque **sigue siendo insuficiente** para ceder autoridad operacional (por eso `ask_gu` + Gu OS como cerebro).
- Tools / function calling, SIP y compatibilidad parcial con el protocolo Realtime de OpenAI, útiles para el adapter.
- Precio esperado al anuncio: USD 0.08/min de audio (verificar en V0).

### 10.3 Alternativas a evaluar más adelante

| Proveedor / modelo | Mejor uso potencial para Gu OS | Consideración |
| --- | --- | --- |
| **GPT-Realtime-2.1 (High)** | Benchmark de control y posible fallback/paridad | Ligeramente superior en dinámica conversacional (95.7% vs 95.1%); agentic más bajo; facturación por tokens de audio, no tarifa plana por minuto; WebRTC/WebSocket/SIP. |
| **Gemini 3.1 Flash Live (High)** | Voz + visión futura; costo | Overall y agentic más bajos; TTFA ~3s en el snapshot; puede interesar si el producto prioriza multimodal (imagen en vivo) o precio; validar límites de sesión y madurez de API. |
| **Grok Voice Think Fast 1.0** | Fallback de costo/compatibilidad dentro de xAI | Inferior en dinámica y velocidad; solo si hace falta pin explícito por precio o regresión. |
| **Cascada STT → Gu texto → TTS** | Degradación cuando falle el realtime | Menos natural, más lenta; conserva todo el cerebro actual de Gu. Es el fallback inmediato del spike (volver al chat de texto), no un segundo speech-to-speech. |
| **LiveKit (u otra capa media)** | Solo con necesidad multi-carrier / mobile / telefonía sofisticada | Infraestructura adicional; no justificarla en el spike. |

### 10.4 Cuándo introducir un segundo proveedor

No por novedad del mercado. Sí cuando exista evidencia de al menos uno de:

1. calidad insuficiente en es-MX (montos, colonias, nombres) tras V5;
2. costo por sesión fuera de umbral con volumen real;
3. indisponibilidad o degradación recurrente de xAI;
4. necesidad de capacidad que Grok no cubra (p. ej. visión en vivo, WebRTC nativo, SIP multi-carrier);
5. benchmark interno controlado donde otro proveedor gane en la métrica que importe al producto.

Hasta entonces: **un adapter (`XaiRealtimeProvider`) + contrato común + fallback a texto**. El cambio mid-utterance entre proveedores no se promete transparente; la recuperación razonable es nueva sesión con contexto reinyectado desde Gu OS.

---

## 11. No-objetivos

- Reemplazar workflows por diálogo model-driven.
- Dar al proveedor de voz acceso directo a Supabase, CRM o integraciones.
- Replicar el catálogo completo de tools y skills en el proveedor.
- Fusionar todos los canales en una conversación universal.
- Convertir cada transcript o resultado en memoria durable.
- Asociar documentos por nombre o proximidad temporal solamente.
- Automatizar llamadas, mensajes, publicaciones o contratos sin política.
- Introducir múltiples proveedores antes de que exista una necesidad medida (ver §10.4).

---

## 12. Decisiones de producto

### PV-001 — Talk to Gu es multimodal, no voice-only

La voz coordina explicaciones, visuales, documentos y acciones. La web es el canvas principal; canales externos complementan la entrega y captura.

### PV-002 — Gu OS conserva autoridad

Los modelos realtime optimizan conversación; Gu OS decide qué capacidades existen, bajo qué identidad y políticas, y qué se ejecutó.

### PV-003 — Casos, decisiones y artefactos antes que threads universales

La continuidad se basa en identidades de dominio y evidencia. Un canal nuevo no justifica fusionar historiales completos.

### PV-004 — Seguimiento de leads puede vivir en este repositorio

Cuando el trabajo sea seguimiento durable y gobernado, puede ejecutarse sobre `lead_follow_up`. La adquisición o atención inicial puede permanecer en otro sistema.

### PV-005 — Proveedor de voz abstraído; Grok 2.0 primero

Primera implementación: `grok-voice-think-fast-2.0` detrás de `RealtimeVoiceProvider`. Alternativas (GPT-Realtime-2.1, Gemini Live, cascada STT/TTS, LiveKit) se evalúan solo con evidencia (§10); no se construyen en el spike.

---

## 13. Relación con la ejecución

Esta visión define **hacia dónde vamos**. El [plan de implementación realtime](./realtime-voice-implementation-plan.md) define el spike inmediato, sus slices, flags, evidencia y rollback. Las capacidades futuras solo se implementan al satisfacer sus precondiciones; mencionarlas aquí no las declara construidas.

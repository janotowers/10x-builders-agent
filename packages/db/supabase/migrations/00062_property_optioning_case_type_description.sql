-- ============================================================
-- 00062_property_optioning_case_type_description.sql
--
-- Actualiza la descripción de alto nivel de property_optioning (pestaña
-- Descripción en settings). Formato intro + bullets vía comas (UI existente).
-- Neutro en ramas interno/externo; sin «coordinar fotos» (paso = solicitar
-- fotos al asesor); «intake» → lenguaje de usuario.
-- ============================================================

update public.operational_case_types
set
  description =
    'Procedimiento end-to-end para obtener la exclusiva o permiso de comercialización de una propiedad: '
    || 'completar registro del caso con datos mínimos de la propiedad, '
    || 'reunir expediente documental (equipo interno o contacto externo), '
    || 'estructurar y validar datos de la propiedad, '
    || 'analizar comparables de mercado, '
    || 'preparar propuesta de precio y aprobación del asesor, '
    || 'preparar contrato y envío al dueño con revisión del asesor, '
    || 'solicitar fotos al asesor interno, '
    || 'preparar y publicar el paquete comercial con aprobaciones internas.',
  updated_at = now()
where case_type = 'property_optioning';

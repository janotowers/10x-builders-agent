/**
 * Detecta intención de "programar una tarea futura / recurrente".
 * Se usa para inyectar un override agresivo al system prompt cuando el modelo
 * tiende a anunciar la programación en texto sin llamar a `schedule_task`.
 */
export function userMessageIsScheduleIntent(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const t = msg
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t.length > 500) return false;

  // Verbos / frases típicas de programar
  const verbHints =
    /\b(programa(r|me)?|agenda(r|me)?|recuerd(a|ame|ame que)|avisa(me)?|notifica(me)?|mandame|envia(me)?)\b/.test(
      t
    );

  // Recurrencia explícita
  const recurringHints =
    /\b(cada|todos los|todas las|diariamente|semanalmente)\s+(\d+\s*)?(minutos?|horas?|dias?|lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|semanas?|meses?)\b/.test(
      t
    );

  // Tiempo futuro relativo
  const futureRelative =
    /\b(en|dentro de)\s+\d+\s+(minutos?|horas?|dias?|semanas?)\b/.test(t) ||
    /\b(hoy|manana|pasado manana)\s+a\s+las\s+\d/.test(t) ||
    /\ba\s+las\s+\d{1,2}(:\d{2})?\s*(am|pm|de la (manana|tarde|noche))?\b/.test(
      t
    );

  // Frases típicas combinadas
  const directPhrases =
    /\b(me\s+puedes\s+(dar|enviar|mandar))\s+.+\s+(cada|en\s+\d|a\s+las)\b/.test(
      t
    ) ||
    /\b(quiero\s+que)\s+.+\s+(cada|en\s+\d|a\s+las|hoy|manana)\b/.test(t);

  return verbHints || recurringHints || futureRelative || directPhrases;
}

/**
 * Heurística: el último mensaje del usuario está relacionado con calendario/evento/cita,
 * no con GitHub. Cuando es true, las tools de creación de GitHub se ocultan para ese turno
 * y así el modelo no confunde "Lab10" con "agent-lab10sem4" ni similares.
 */
export function userMessageIsCalendarRelated(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const t = msg
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t.length > 500) return false;

  const mentionsGithub =
    /\b(github|repo(s|sitorio|sitorios)?|issues?|pull\s*request|commits?)\b/i.test(
      t
    );
  if (mentionsGithub) return false;

  const calendarPatterns: RegExp[] = [
    /\b(evento|eventos|cita|citas|agenda|calendario|calendarios)\b/,
    /\b(event|events|appointment|calendar|calendars|schedule)\b/,
    /\b(10\s*am|10\s*pm|\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*hrs?)\b/,
    /\b(manana|pasado\s*manana|hoy|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/,
    /\b(duracion|hora\s+de\s+inicio|hora\s+de\s+fin)\b/,
    /\b(titulo|descripcion|summary|description)\b.*\b(evento|event|cita|appointment)\b/,
    /\b(crear|agendar|programar|reservar|bloquear)\b.*\b(evento|cita|reunion|junta|sesion|clase|curso)\b/,
    /\b(create|schedule|book)\b.*\b(event|meeting|appointment|session|class)\b/,
  ];

  return calendarPatterns.some((p) => p.test(t));
}

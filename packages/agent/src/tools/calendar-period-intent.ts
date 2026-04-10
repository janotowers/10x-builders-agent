/**
 * Mensajes que suelen ser solo la elección de período para ver eventos de calendario,
 * sin mencionar GitHub. Evita que el modelo confunda "esta semana" con listar repos.
 */
export function userMessageAnchorsCalendarPeriodOnly(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const t = msg.trim();
  if (t.length > 200) return false;

  const mentionsGithub =
    /\b(github|gh\b|repo|repos|repositor|repositorio|issues?|pull\s*request|commits?)\b/i.test(
      t
    );
  if (mentionsGithub) return false;

  const patterns: RegExp[] = [
    /^(de\s+)?(esta|la)\s+semana\.?$/i,
    /^esta\s+semana\.?$/i,
    /^hoy\.?$/i,
    /^mañana\.?$/i,
    /^pasado\s+mañana\.?$/i,
    /^ayer\.?$/i,
    /^el\s+mes(\s+en\s+curso)?\.?$/i,
    /^este\s+mes\.?$/i,
    /^(de\s+)?este\s+mes\.?$/i,
    /^la\s+próxima\s+semana\.?$/i,
    /^próxima\s+semana\.?$/i,
    /^semana\s+que\s+viene\.?$/i,
    /^la\s+semana\s+que\s+viene\.?$/i,
    /^this\s+week\.?$/i,
    /^today\.?$/i,
    /^tomorrow\.?$/i,
    /^next\s+week\.?$/i,
  ];

  return patterns.some((p) => p.test(t));
}

/**
 * Detecta cuando el mensaje trata de **cómo** debe contestar el asistente
 * (tono, bullets, claridad) sin pedir acceso a repositorios, calendario, etc.
 * Se usa para no exponer `github_list_repos` en ese turno y evitar
 * "listar repos" al pedir listas con viñetas.
 */

export function userMessageIsResponseFormatOrStyleOnly(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const raw = msg.trim();
  if (raw.length < 8) return false;
  if (raw.length > 4000) return false;
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(github|git\s*hub|gh)\b/i.test(t)) {
    return false;
  }
  if (/\b(repositorio|repositorios)\b/i.test(t)) {
    return false;
  }
  if (/\b(mis|my|nuestros?|the)\s+repos?\b/i.test(t)) {
    return false;
  }
  if (/\blista(\s+de)?\s+(mis\s+)?(repos?|repositorios?)\b/i.test(t)) {
    return false;
  }
  if (/\b(muestra|muestr(ame|a)|dame|listar?)\b/i.test(t) && /\b(repos?|repositorios?|github)\b/i.test(t)) {
    return false;
  }
  if (/\b(crea(r)?\s+un|nueva?|new)\s+repositori/i.test(t)) {
    return false;
  }

  const hasStyleOrFormatIntent =
    /\b(bullets?|puntos?\s+por|items?\s+o\s+ejemplos?|muchos?\s+items?|muchos?\s+ejemplos?)\b/i.test(
      t
    ) ||
    /viñet|vinete/i.test(raw) ||
    /prefi(er|)o\s+que(\s+te|\s+me|\s+us|\s+el|\s+la)/i.test(t) ||
    /prefi(er|)o\s+que(\s+uses?|\s+respondas?)/i.test(t) ||
    /\bcuando\s+.*\b(respuesta|responder|mencionar|items?|ejemplos?)\b/i.test(
      t
    ) ||
    /en\s+tu(s)?\s+respuestas?/i.test(t) ||
    /formato(\s+de(\s+la)?\s*respuest|\s*con)/i.test(t) ||
    /\b(mas|más)\s+clar(o|a|es)\b/i.test(t) ||
    /puntualiz(ar|a|acion)/i.test(t) ||
    /\brespuestas?\s+(cortas|largas|en\s+lista|en\s+viñet)/i.test(t) ||
    /usa(r)?\s+listas?(\s+con)?/i.test(t) ||
    /(\s|^)(enumerad|resumiendo\s+en|tldr)\b/i.test(t) ||
    /\b(tono|estilo|markdown|listado\s+con)\b/i.test(t);

  return hasStyleOrFormatIntent;
}

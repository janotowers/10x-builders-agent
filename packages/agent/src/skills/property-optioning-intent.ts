/**
 * Deterministic intent guard for the canonical operational case pilot.
 *
 * The LLM selector is still the general router, but this workflow is a core
 * product path: a user saying "necesito opcionar una propiedad" should never
 * fall through to `none` because the selector was conservative. Keep this
 * guard narrow and Spanish-first; broader routing still belongs to the LLM.
 */

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[¿?¡!.,;:()"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPropertyOptioningIntent(message: string | null | undefined) {
  const text = normalizeForIntent(message ?? "");
  if (!text) return false;

  const propertyNoun =
    /\b(propiedad(?:es)?|propieda[ds]|casa|depto|departamento|inmueble|terreno|local)\b/.test(
      text
    );

  if (/\bopcion(?:ar|ando|e|emos|arla|arlo|arlas|arlos)?\b/.test(text)) {
    return propertyNoun || /\bpropiedad\b/.test(text);
  }

  if (/\b(exclusiva|captacion|captar)\b/.test(text) && propertyNoun) {
    return true;
  }

  if (/\bcontrato de comision\b/.test(text) && propertyNoun) {
    return true;
  }

  if (
    /\b(publicar|subir|listar)\b/.test(text) &&
    propertyNoun &&
    /\b(easybroker|portal|portales|publicacion)\b/.test(text)
  ) {
    return true;
  }

  if (
    /\b(comparables|precio de salida|analisis de mercado)\b/.test(text) &&
    propertyNoun
  ) {
    return true;
  }

  return false;
}

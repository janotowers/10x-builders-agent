/**
 * Heurística para detectar si el mensaje del usuario es claramente una petición
 * sobre archivos del workspace (leer/crear/editar/buscar), de forma que podamos
 * ocultar tools de dominios ajenos (calendar, github_create_*) en ese turno y
 * evitar que el modelo "salte" a otro carril por ruido del histórico.
 *
 * Sesgo conservador: en duda, devolver false (no ocultar otras tools).
 */
export function userMessageIsFileToolsIntent(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const t = msg
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t.length === 0 || t.length > 500) return false;

  // Señales de otros dominios — si aparecen explícitamente, NO asumir intención de archivos.
  const mentionsCalendar =
    /\b(evento|eventos|cita|citas|agenda|calendario|calendarios|reunion|junta)\b/.test(
      t
    ) ||
    /\b(event|events|appointment|calendar|calendars|schedule|meeting)\b/.test(
      t
    );
  const mentionsGithub =
    /\b(github|repo(s|sitorio|sitorios)?|issues?|pull\s*request|commits?)\b/.test(
      t
    );
  if (mentionsCalendar || mentionsGithub) return false;

  // Señales fuertes: extensión de archivo tipo .md / .ts / .json / .txt / .yaml, ruta con /,
  // o verbos de acción sobre "archivo/fichero".
  const containsUrl = /https?:\/\//.test(t);

  const extensionHit =
    !containsUrl &&
    (/\b[\w.\-]+\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|rs|go|java|kt|rb|sh|ps1|env|lock|sql|csv|xml|html?|css|scss|tf|example|local)\b/.test(
      t
    ) ||
      /(^|\s)\.(env|gitignore|npmrc|cursorrules|editorconfig)\b/.test(t));

  const relPathHit =
    !containsUrl && /\b[\w.\-]+\/[\w.\-/]+\b/.test(t);

  const fileVerbs =
    /\b(lee|leer|abre|abrir|muestra|mostrar|contenido|ver)\b.*\b(archivo|fichero|fichero|file)\b/.test(
      t
    ) ||
    /\b(archivo|fichero|file)\b.*\b(lee|leer|abre|abrir|muestra|mostrar|contenido)\b/.test(
      t
    ) ||
    /\b(crea|crear|escribe|escribir|sobrescribe|sobrescribir|guarda|guardar)\b.*\b(archivo|fichero|file)\b/.test(
      t
    ) ||
    /\b(edita|editar|modifica|modificar|sustituye|sustituir|reemplaza|reemplazar|cambia|cambiar|ajusta|ajustar)\b.*\b(archivo|fichero|file|linea|lineas|texto|contenido|fragmento|palabra|string)\b/.test(
      t
    ) ||
    /\b(en\s+el\s+archivo|en\s+el\s+fichero|in\s+the\s+file)\b/.test(t) ||
    /\b(read|open|show|display|print)\b.*\b(file|content)\b/.test(t) ||
    /\b(write|create|overwrite|save)\b.*\b(file|content)\b/.test(t) ||
    /\b(edit|modify|replace|change)\b.*\b(file|line|content|text|word|string)\b/.test(
      t
    );

  const fileNounAlone =
    /\barchivo\s+[\w.\-\/]+/.test(t) || /\bfile\s+[\w.\-\/]+/.test(t);

  return extensionHit || relPathHit || fileVerbs || fileNounAlone;
}

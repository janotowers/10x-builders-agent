/**
 * Detecta intención de listar o inspeccionar archivos/carpetas del **host del servidor**
 * (shell local), frente a listar repositorios en GitHub.
 */
export function userMessageIsLocalShellOrFilesystemIntent(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const t = msg
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (t.length > 500) return false;

  const explicitGithubRepoList =
    /\b(lista|dame|muestra|enumer)\w*\s+(mis\s+|los\s+|tus\s+)?(repos|repositorios)(\s+de\s+github|\s+en\s+github)?\b/.test(
      t
    ) ||
    /\b(mis|tus)\s+repos(itorios)?(\s+en\s+github|\s+de\s+github)\b/.test(t) ||
    /\brepos(itorios)?\s+en\s+github\b/.test(t) ||
    /\bgithub\s+repos?\b/.test(t);

  const localHints =
    /\b(carpeta|directorio|folder|archivos?|ficheros?|ls\b|pwd\b|bash|shell|terminal|servidor|disco|filesystem|directorio actual|carpeta actual|current (directory|folder))\b/.test(
      t
    );

  if (explicitGithubRepoList && !localHints) return false;

  const localPatterns: RegExp[] = [
    /\b(carpeta|directorio|folder)\s+actual\b/,
    /\barchivos?\b.*\b(en|de)\b.*\b(carpeta|directorio|folder)\b/,
    /\b(ficheros?|archivos?)\s+(en|de)\s+(la|esta|el)?\s*(carpeta|directorio|folder)\b/,
    /\b(lista|listar|enumerar|muestra|dame)\w*.*\b(archivos?|ficheros?)\b/,
    /^\s*(ls|pwd|dir)\s*$/i,
    /\b(ls|pwd)\s+[-a-z0-9]/i,
    /\bcontenido\s+(de\s+)?(la\s+)?(carpeta|directorio)\b/,
    /\bfiles?\s+in\s+(the\s+)?(current\s+)?(directory|folder)\b/,
    /\bqu[eé]\s+hay\s+en\s+(esta|la)?\s*(carpeta|directorio)\b/,
    /\bruta\s+actual\b/,
    /\bworking\s+directory\b/,
  ];

  return localPatterns.some((p) => p.test(t));
}

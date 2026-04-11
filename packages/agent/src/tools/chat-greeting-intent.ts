/**
 * Mensajes cortos de saludo o comprobación de presencia, sin pedido de datos (GitHub, etc.).
 * Evita que el modelo invoque github_list_repos ante "¿sigues ahí?".
 */
export function userMessageIsPresenceOrGreetingOnly(
  msg: string | undefined
): boolean {
  if (!msg || typeof msg !== "string") return false;
  const raw = msg.trim();
  if (!raw || raw.length > 160) return false;

  let t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  /* Quitar ¿ inicial para que "¿sigues ahí?" coincida con patrones que empiezan en sigues/estás */
  t = t.replace(/^[\u00bf¿]+\s*/u, "").trim();
  if (!t) return false;

  if (
    /\b(github|gh\b|repos?\b|repositor|repositorio|issues?|pull\s*request|commits?|calendario|citas?|agenda|eventos?)\b/i.test(
      t
    )
  ) {
    return false;
  }

  const patterns: RegExp[] = [
    /^(hola|hi|hello|hey|buenas|buenos\s+dias)[\s,!.]*$/,
    /^(hola|hi|hello|hey|buenas)[\s,!.]*(sigues|estas)\s+(ahi|aqui)\??[\s!.]*$/,
    /^(sigues|estas)\s+(ahi|aqui)\??[\s!.]*$/,
    /^(\?)?(sigues|estas)\s+(ahi|aqui)\??[\s!.]*$/,
    /^(te\s+)?(escuchas|oyes|recibes)\??[\s!.]*$/,
    /^ping[\s!.]*$/,
    /^(gracias|thanks|thank\s+you|ok|vale|listo|perfecto|genial)[\s!.]*$/,
    /^(que\s+tal|como\s+estas|como\s+va)\??[\s!.]*$/,
  ];

  return patterns.some((p) => p.test(t));
}

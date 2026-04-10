/**
 * Heurística para no ofrecer github_create_issue cuando el usuario pide crear un repo nuevo.
 * El modelo a menudo elige create_issue con owner/repo aunque el repo no exista.
 */
export function userWantsNewGithubRepository(message: string): boolean {
  const t = message.trim();
  if (!t) return false;
  const m = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const patterns: RegExp[] = [
    /\bcrea(r)?\s+(el\s+|un\s+|una\s+)?(repositorio|repo)\b/,
    /\bcrear\s+(un\s+|el\s+|la\s+)?(repositorio|repo)\b/,
    /\b(nuevo|nueva)\s+(repositorio|repo)\b/,
    /\b(repositorio|repo)\s+(nuevo|nueva|llamado|llamada|nombrado|nombrada)\b/,
    /\bhaz(me)?\s+(un\s+|el\s+)?(repositorio|repo)\b/,
    /\bcreate\s+(a\s+|the\s+)?(new\s+)?(repository|repo)\b/,
    /\bnew\s+(repository|repo)\b/,
    /\b(init|initialize|initialise)\s+(a\s+)?(repository|repo)\b/,
  ];

  return patterns.some((p) => p.test(m));
}

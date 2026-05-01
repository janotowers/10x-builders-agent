/**
 * Composite skill resolver.
 *
 * Skills can declare `includes: [other-skill, ...]` in their frontmatter to
 * compose larger playbooks from smaller coherent units. The resolver:
 *
 *   1. Walks `includes` depth-first (children before parent in the merged
 *      body), preserving authoring order.
 *   2. Detects cycles (`a → b → a`) and rejects them with a clear error.
 *   3. Concatenates bodies with section separators so the model can tell
 *      which playbook contributed which guidance.
 *   4. Unions `allowed_tools` across all composed skills, dedup-preserving
 *      first-seen order so the most relevant skill's tools come first.
 *   5. Enforces the same 5k-token body cap as a single SKILL.md, applied
 *      to the **merged** body. Composites that exceed the cap fail at
 *      resolve time so a misuse can't silently push the system prompt over
 *      the compaction threshold.
 *
 * The resolver does not invoke the registry's `loadBody()` for the root
 * itself: the caller passes the already-loaded root body so this function
 * stays pure with respect to disk IO. Children's bodies are loaded via
 * the registry argument.
 */
import { estimateTokens, MAX_SKILL_BODY_TOKENS } from "./parse";
import type { ResolvedSkill, SkillRegistry } from "./types";

export class SkillResolveError extends Error {
  constructor(
    message: string,
    readonly rootName: string,
    readonly trail?: readonly string[]
  ) {
    const suffix = trail && trail.length > 0 ? ` (path: ${trail.join(" -> ")})` : "";
    super(`${message}${suffix}`);
    this.name = "SkillResolveError";
  }
}

/**
 * Resolve a single skill (and any transitive `includes`) into one playbook
 * payload. Throws `SkillResolveError` on missing dependency, cycle, or
 * over-budget body.
 */
export async function resolveSkill(
  rootName: string,
  registry: SkillRegistry
): Promise<ResolvedSkill> {
  const root = registry.get(rootName);
  if (!root) {
    throw new SkillResolveError(
      `unknown skill '${rootName}'`,
      rootName,
      [rootName]
    );
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  await visit(rootName, registry, order, visited, visiting, [rootName]);

  const allowedTools: string[] = [];
  const seenTools = new Set<string>();
  const sections: string[] = [];
  let requiresTenantContext = false;

  for (const slug of order) {
    const rec = registry.get(slug);
    if (!rec) {
      throw new SkillResolveError(
        `unknown skill '${slug}' referenced by '${rootName}'`,
        rootName,
        order
      );
    }
    for (const tool of rec.metadata.allowedTools) {
      if (!seenTools.has(tool)) {
        seenTools.add(tool);
        allowedTools.push(tool);
      }
    }
    if (rec.metadata.requiresTenantContext) {
      requiresTenantContext = true;
    }
    const body = (await rec.loadBody()).trim();
    if (body) {
      const header =
        slug === rootName
          ? `## Skill: ${slug}`
          : `## Included skill: ${slug}`;
      sections.push(`${header}\n\n${body}`);
    }
  }

  const merged = sections.join("\n\n---\n\n").trim();
  const tokens = estimateTokens(merged);

  if (tokens > MAX_SKILL_BODY_TOKENS) {
    throw new SkillResolveError(
      `composed body exceeds ${MAX_SKILL_BODY_TOKENS}-token cap (~${tokens} estimated)`,
      rootName,
      order
    );
  }

  return {
    rootName,
    composedFrom: Object.freeze([...order]),
    body: merged,
    allowedTools: Object.freeze(allowedTools),
    estimatedTokens: tokens,
    requiresTenantContext,
  };
}

async function visit(
  slug: string,
  registry: SkillRegistry,
  order: string[],
  visited: Set<string>,
  visiting: Set<string>,
  trail: string[]
): Promise<void> {
  if (visited.has(slug)) return;
  if (visiting.has(slug)) {
    throw new SkillResolveError(
      `composite cycle detected at '${slug}'`,
      trail[0] ?? slug,
      trail
    );
  }

  const rec = registry.get(slug);
  if (!rec) {
    throw new SkillResolveError(
      `unknown skill '${slug}'`,
      trail[0] ?? slug,
      trail
    );
  }

  visiting.add(slug);
  for (const child of rec.metadata.includes) {
    await visit(child, registry, order, visited, visiting, [...trail, child]);
  }
  visiting.delete(slug);

  visited.add(slug);
  order.push(slug);
}

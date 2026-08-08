import { promises as fs } from "node:fs";
import path from "node:path";
import { readSkillReference } from "@agents/agent";

const SKILL_SLUG = "skill-authoring";
const REFERENCE_NAMES = [
  "skill-contract",
  "operational-case-authoring",
  "output-formats",
] as const;

export interface AuthoringDoctrine {
  skillBody: string;
  references: Record<(typeof REFERENCE_NAMES)[number], string>;
  combined: string;
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.join("apps", "web")) ? path.resolve(cwd, "../..") : cwd;
}

let doctrinePromise: Promise<AuthoringDoctrine> | null = null;

async function readDoctrine(): Promise<AuthoringDoctrine> {
  const root = repoRoot();
  const skillPath = path.join(root, "skills", "global", SKILL_SLUG, "SKILL.md");
  const skillBody = await fs.readFile(skillPath, "utf8");
  const entries = await Promise.all(
    REFERENCE_NAMES.map(async (name) => {
      const result = await readSkillReference({
        name,
        activeSkillName: SKILL_SLUG,
        referenceSkillNames: [SKILL_SLUG],
        skillsRoot: root,
      });
      if (result.status !== "ok") {
        throw new Error(`No se pudo cargar ${SKILL_SLUG}/${name}: ${result.message}`);
      }
      return [name, result.content] as const;
    })
  );
  const references = Object.fromEntries(entries) as AuthoringDoctrine["references"];
  const combined = [
    `# ${SKILL_SLUG}/SKILL.md`,
    skillBody,
    ...entries.flatMap(([name, content]) => [
      `# ${SKILL_SLUG}/references/${name}.md`,
      content,
    ]),
  ].join("\n\n");
  return { skillBody, references, combined };
}

/** Carga una sola doctrina compartida para Studio y skill-authoring. */
export function loadAuthoringDoctrine(): Promise<AuthoringDoctrine> {
  doctrinePromise ??= readDoctrine().catch((error) => {
    doctrinePromise = null;
    throw error;
  });
  return doctrinePromise;
}


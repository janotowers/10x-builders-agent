/**
 * Global skill registry loader.
 *
 * Walks the `skills/global/` directory tree, parses each `SKILL.md`, and
 * returns a metadata-only registry. Bodies are not held in memory; they
 * are read on demand the first time `record.loadBody()` is called.
 *
 * Convention (per V1-A roadmap):
 *
 *   skills/global/<slug>/SKILL.md       <- required
 *   skills/global/<slug>/references/    <- optional, ignored at load
 *   skills/global/<slug>/assets/        <- optional, ignored at load
 *   skills/global/<slug>/scripts/       <- reserved for V2+, ignored
 *
 * Slugs follow the Anthropic Skills spec (lowercase letters, digits and
 * hyphens, starting with a letter or digit). The registry only scans
 * `skills/global/`; tests should compose registries from temp directories
 * via `buildRegistryFromRecords` or by writing files under their own root.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseSkillFile, SkillParseError } from "./parse";
import type { SkillMetadata, SkillRecord, SkillRegistry } from "./types";

export interface LoadRegistryOptions {
  /**
   * Optional logger called once per skill that fails to parse. By default
   * the first parse error is rethrown so misconfigurations surface loudly
   * at boot. Tests / tools may pass `() => {}` to keep the registry partial.
   */
  readonly onParseError?: (err: SkillParseError) => void;
}

const SKILL_FILENAME = "SKILL.md";

/**
 * Load all global skills from `<rootDir>/skills/global`. Returns an empty
 * registry when the directory does not exist (the project may not yet ship
 * any skills); other IO errors propagate to the caller.
 */
export async function loadGlobalSkillRegistry(
  rootDir: string,
  options: LoadRegistryOptions = {}
): Promise<SkillRegistry> {
  const baseDir = path.resolve(rootDir, "skills", "global");

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return buildRegistry(new Map());
    }
    throw err;
  }

  const records = new Map<string, SkillRecord>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;

    const skillPath = path.join(baseDir, slug, SKILL_FILENAME);
    try {
      const stat = await fs.stat(skillPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    let record: SkillRecord;
    try {
      record = await parseSkillFile(skillPath);
    } catch (err) {
      if (err instanceof SkillParseError) {
        if (options.onParseError) {
          options.onParseError(err);
          continue;
        }
        throw err;
      }
      throw err;
    }

    if (records.has(record.metadata.name)) {
      throw new SkillParseError(
        `duplicate skill name '${record.metadata.name}' (already loaded from ${records.get(record.metadata.name)!.metadata.sourcePath})`,
        skillPath
      );
    }
    records.set(record.metadata.name, record);
  }

  return buildRegistry(records);
}

function buildRegistry(records: Map<string, SkillRecord>): SkillRegistry {
  const frozenList: readonly SkillMetadata[] = Object.freeze(
    Array.from(records.values())
      .map((r) => r.metadata)
      .sort((a, b) => a.name.localeCompare(b.name))
  );

  return {
    get size(): number {
      return records.size;
    },
    get(name: string): SkillRecord | undefined {
      return records.get(name);
    },
    list(): readonly SkillMetadata[] {
      return frozenList;
    },
    has(name: string): boolean {
      return records.has(name);
    },
  };
}

/**
 * Build a `SkillRegistry` from already-parsed records. Useful for tests
 * and for callers that want to register skills loaded from non-disk
 * sources (e.g. future DB-backed account skills).
 */
export function buildRegistryFromRecords(
  records: readonly SkillRecord[]
): SkillRegistry {
  const map = new Map<string, SkillRecord>();
  for (const r of records) {
    if (map.has(r.metadata.name)) {
      throw new Error(
        `duplicate skill name '${r.metadata.name}' in buildRegistryFromRecords`
      );
    }
    map.set(r.metadata.name, r);
  }
  return buildRegistry(map);
}

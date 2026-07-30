import type { WorkflowDefinition } from "@agents/types";

/**
 * Cached definition loader (S1.4-5): published definitions are immutable, so
 * (definitionId, version) entries cache forever within a process. The fetcher
 * is injected (usually a @agents/db query bound to a service client) to keep
 * this package free of database dependencies.
 */
export function createWorkflowDefinitionLoader(
  fetchDefinition: (
    definitionId: string,
    version: number
  ) => Promise<WorkflowDefinition | null>
): (definitionId: string, version: number) => Promise<WorkflowDefinition | null> {
  const cache = new Map<string, Promise<WorkflowDefinition | null>>();
  return (definitionId, version) => {
    const key = `${definitionId}@${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = fetchDefinition(definitionId, version).catch((error) => {
      // Do not cache failures; a transient DB error must not pin null forever.
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  };
}

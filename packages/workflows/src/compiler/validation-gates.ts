/**
 * Gates de validación pre-publicación (Slice 4.2-2; Technical Plan §5.4).
 *
 * Cada gate produce un resultado con shape de evidence record
 * (`gate` + `result` + `detail`): la capa web lo persiste en
 * `evidence_records` con `subject_kind = "workflow_definition"` y
 * `artifact_hash = definition_hash`, de modo que la decisión de publicación
 * queda auditada contra la versión exacta del grafo.
 *
 * Política de fallo (§5.4): los gates estructurales, de capacidades
 * BLOQUEANTES, de permisos y de credenciales impiden publicar. Los gaps de
 * assets/integraciones NO fallan el gate — son backlog del cliente y viajan
 * en el detail del gate de capacidades.
 */

import { validateWorkflowGraph } from "../graph-schema";
import type { WorkflowGraph } from "@agents/types";
import {
  resolveCapabilityMap,
  type CapabilityCatalogs,
  type CapabilityMapResult,
} from "./capability-map";
import {
  businessSpecSchema,
  implementationSpecSchema,
  specIsPresent,
  type ImplementationSpec,
} from "./spec-schemas";
import {
  detectUnrequestedSideEffects,
} from "./authoring-router";
import { inputRequirementSchema } from "./input-requirements";

export type CompilerGateName =
  | "spec_schema"
  | "graph_schema"
  | "acyclicity"
  | "reachability"
  | "capability_resolution"
  | "permission_validation"
  | "credential_shape"
  | "fidelity"
  | "simulation";

export interface CompilerGateResult {
  gate: CompilerGateName;
  result: "pass" | "fail";
  detail: Record<string, unknown>;
}

export interface DefinitionValidationInput {
  /** `graph_jsonb` crudo (se parsea aquí; nunca se confía en el caller). */
  graphValue: unknown;
  businessSpecValue?: unknown;
  implementationSpecValue?: unknown;
  catalogs: CapabilityCatalogs;
}

export interface DefinitionValidationResult {
  /** true cuando TODOS los gates pasan (los gaps backlog no fallan). */
  ok: boolean;
  graph: WorkflowGraph | null;
  gates: CompilerGateResult[];
  capabilityMap: CapabilityMapResult | null;
}

function gateResult(
  gate: CompilerGateName,
  failures: string[],
  extraDetail?: Record<string, unknown>
): CompilerGateResult {
  return {
    gate,
    result: failures.length === 0 ? "pass" : "fail",
    detail: {
      ...(failures.length > 0 ? { failures } : {}),
      ...(extraDetail ?? {}),
    },
  };
}

// ─── Gate: specs contra schema ──────────────────────────────────────────────

function runSpecSchemaGate(
  businessSpecValue: unknown,
  implementationSpecValue: unknown
): CompilerGateResult {
  const failures: string[] = [];
  const present: string[] = [];
  if (specIsPresent(businessSpecValue)) {
    present.push("business_spec");
    const parsed = businessSpecSchema.safeParse(businessSpecValue);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        failures.push(
          `business_spec.${issue.path.join(".") || "<root>"}: ${issue.message}`
        );
      }
    }
  }
  if (specIsPresent(implementationSpecValue)) {
    present.push("implementation_spec");
    const parsed = implementationSpecSchema.safeParse(implementationSpecValue);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        failures.push(
          `implementation_spec.${issue.path.join(".") || "<root>"}: ${issue.message}`
        );
      }
    }
  }
  return gateResult("spec_schema", failures, { specs_present: present });
}

// ─── Gate: rechazo de credenciales embebidas ────────────────────────────────

const CREDENTIAL_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

const CREDENTIAL_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "openai_style_key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./ },
];

function scanForCredentials(
  value: unknown,
  path: string,
  findings: string[]
): void {
  if (typeof value === "string") {
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.re.test(value)) {
        findings.push(`${path || "<root>"}: value matches ${pattern.name}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForCredentials(item, `${path}[${index}]`, findings)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (
        CREDENTIAL_KEY_PATTERN.test(key) &&
        typeof child === "string" &&
        child.trim().length > 0
      ) {
        findings.push(`${childPath}: credential-shaped key with inline value`);
      }
      scanForCredentials(child, childPath, findings);
    }
  }
}

function runCredentialShapeGate(values: {
  graphValue: unknown;
  businessSpecValue?: unknown;
  implementationSpecValue?: unknown;
}): CompilerGateResult {
  const findings: string[] = [];
  scanForCredentials(values.graphValue, "graph", findings);
  scanForCredentials(values.businessSpecValue, "business_spec", findings);
  scanForCredentials(
    values.implementationSpecValue,
    "implementation_spec",
    findings
  );
  return gateResult("credential_shape", findings);
}

// ─── Gate: permisos (tools referenciados existen y están permitidos) ────────

function runPermissionGate(
  graph: WorkflowGraph,
  catalogs: CapabilityCatalogs
): CompilerGateResult {
  const failures: string[] = [];
  const toolIds = new Set(catalogs.toolIds);
  const skillsUsed = new Set(
    graph.step_bindings
      .map((binding) => binding.skill)
      .filter((skill): skill is string => Boolean(skill))
  );
  for (const skill of skillsUsed) {
    for (const toolId of catalogs.skillAllowedTools?.get(skill) ?? []) {
      if (!toolIds.has(toolId)) {
        failures.push(
          `skill "${skill}" declara la tool "${toolId}" que no existe en el catálogo`
        );
      }
    }
  }
  return gateResult("permission_validation", failures, {
    skills_checked: [...skillsUsed].sort(),
  });
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export function runDefinitionValidationGates(
  input: DefinitionValidationInput
): DefinitionValidationResult {
  const gates: CompilerGateResult[] = [];

  gates.push(
    runSpecSchemaGate(input.businessSpecValue, input.implementationSpecValue)
  );

  // Estructural: un solo pase de validateWorkflowGraph, repartido en los
  // tres gates normativos (schema / aciclicidad / alcanzabilidad).
  const structural = validateWorkflowGraph(input.graphValue);
  const byCode = (codes: string[]) =>
    structural.issues
      .filter((issue) => codes.includes(issue.code))
      .map((issue) => `${issue.code}: ${issue.detail}`);
  gates.push(
    gateResult(
      "graph_schema",
      byCode(["schema_invalid", "duplicate_state", "unknown_state_reference"])
    )
  );
  gates.push(gateResult("acyclicity", byCode(["cycle_detected"])));
  gates.push(
    gateResult("reachability", byCode(["unreachable_state", "dead_end_state"]))
  );

  gates.push(
    runCredentialShapeGate({
      graphValue: input.graphValue,
      businessSpecValue: input.businessSpecValue,
      implementationSpecValue: input.implementationSpecValue,
    })
  );

  let capabilityMap: CapabilityMapResult | null = null;
  const implParsed = specIsPresent(input.implementationSpecValue)
    ? implementationSpecSchema.safeParse(input.implementationSpecValue)
    : null;
  const inputRequirements =
    implParsed?.success
      ? implParsed.data.input_requirements
      : [];

  if (structural.graph) {
    capabilityMap = resolveCapabilityMap(structural.graph, input.catalogs, {
      inputRequirements,
    });
    gates.push(
      gateResult(
        "capability_resolution",
        capabilityMap.blockingGaps.map(
          (gap) => `${gap.kind} "${gap.key}" sin resolver`
        ),
        {
          backlog_gaps: capabilityMap.gaps
            .filter((gap) => !gap.blocking)
            .map((gap) => ({
              kind: gap.kind,
              key: gap.key,
              customer_message: gap.customerMessage,
              link_hint: gap.linkHint,
            })),
        }
      )
    );
    gates.push(runPermissionGate(structural.graph, input.catalogs));
    gates.push(
      runFidelityGate({
        graph: structural.graph,
        businessSpecValue: input.businessSpecValue,
        implementationSpec: implParsed?.success ? implParsed.data : null,
      })
    );
  } else {
    // Sin grafo parseable no hay nada que resolver: ambos gates fallan con
    // referencia al gate estructural para no duplicar el detalle.
    gates.push(
      gateResult("capability_resolution", ["graph_schema falló: sin grafo"])
    );
    gates.push(
      gateResult("permission_validation", ["graph_schema falló: sin grafo"])
    );
    gates.push(gateResult("fidelity", ["graph_schema falló: sin grafo"]));
  }

  return {
    ok: gates.every((gate) => gate.result === "pass"),
    graph: structural.graph,
    gates,
    capabilityMap,
  };
}

function runFidelityGate(params: {
  graph: WorkflowGraph;
  businessSpecValue?: unknown;
  implementationSpec: ImplementationSpec | null;
}): CompilerGateResult {
  const failures: string[] = [];
  const descriptionNl =
    params.businessSpecValue &&
    typeof params.businessSpecValue === "object" &&
    !Array.isArray(params.businessSpecValue) &&
    typeof (params.businessSpecValue as { description_nl?: unknown })
      .description_nl === "string"
      ? ((params.businessSpecValue as { description_nl: string }).description_nl)
      : "";

  const stateKeys = params.graph.states.map((s) => s.key).join(" ");
  const summary = params.implementationSpec?.summary ?? "";
  const sendsMessage =
    /\b(envio|enviar|mensaje_enviado|send)\b/i.test(stateKeys) ||
    /\benv[ií]o\b/i.test(summary);
  const requiresApproval =
    params.graph.transitions.some((t) => Boolean(t.approval_required)) ||
    (params.graph.approvals?.length ?? 0) > 0;
  const hasSchedule = /\b(cron|schedule|recurren|cada lunes)\b/i.test(
    `${summary} ${descriptionNl}`
  );

  failures.push(
    ...detectUnrequestedSideEffects({
      description: descriptionNl,
      compiledSignals: {
        sendsMessage,
        requiresApproval,
        hasSchedule: false, // schedule is a router concern; don't double-count NL
        createsCaseWorkflow: true,
      },
    })
  );

  // Coherence: implementation states should be a subset of graph states.
  if (params.implementationSpec) {
    const graphKeys = new Set(params.graph.states.map((s) => s.key));
    for (const state of params.implementationSpec.states) {
      if (!graphKeys.has(state.key)) {
        failures.push(
          `implementation_spec.state "${state.key}" no existe en el grafo`
        );
      }
    }
  }

  // Validate typed input requirements if present.
  for (const req of params.implementationSpec?.input_requirements ?? []) {
    const parsed = inputRequirementSchema.safeParse(req);
    if (!parsed.success) {
      failures.push(`input_requirement inválido: ${req.key}`);
    }
  }

  return gateResult("fidelity", failures, {
    description_present: Boolean(descriptionNl),
  });
}

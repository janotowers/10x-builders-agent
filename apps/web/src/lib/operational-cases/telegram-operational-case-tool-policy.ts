/**
 * @deprecated La política de aprobación de tools del caso es agnóstica de canal.
 * La fuente única ahora vive en `conversational-case-orchestrator.ts` como
 * `buildOperationalCaseToolApprovalPolicy`. Este archivo re-exporta con el
 * nombre histórico para no romper los imports existentes (webhook de Telegram y
 * su selftest). Prefiere importar `buildOperationalCaseToolApprovalPolicy`.
 */
export { buildOperationalCaseToolApprovalPolicy as buildTelegramOperationalCaseToolApprovalPolicy } from "./conversational-case-orchestrator";

export type AppliedSkillRole = "primary" | "included";

export type AppliedSkillDisplay = {
  id: string;
  role: AppliedSkillRole;
};

const SKILL_LABELS_ES: Record<string, string> = {
  "brand-kit": "Guía de marca",
  "business-data-core": "Base de datos de negocio",
  "client-meeting-prep": "Preparación de reunión con cliente",
  "company-data": "Datos de empresa",
  "conversation-risk-watch": "Vigilancia de conversaciones en riesgo",
  "compose-message": "Redacción de mensajes",
  "daily-operating-brief": "Resumen operativo del día",
  "doc-coauthoring": "Coautoría de documentos",
  "errand-planner": "Planeación de pendientes",
  "family-reminders": "Recordatorios personales y familiares",
  "inventory-matchmaking-watch": "Vigilancia de cruces con inventario",
  "lead-follow-up-draft": "Seguimiento de leads",
  "lead-momentum-watch": "Vigilancia de momentum de leads",
  "meeting-readiness-watch": "Vigilancia de reuniones próximas",
  "memory-curate": "Gestión de memoria",
  "pending-approval-watch": "Vigilancia de aprobaciones pendientes",
  "personal-day-briefing": "Resumen personal del día",
  "travel-prep": "Preparación de viaje",
  "visit-confirmation-watch": "Vigilancia de visitas por confirmar",
};

function humanizeSkillId(skillId: string): string {
  return skillId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatSkillForUserPanel(skillId: string): string {
  const label = SKILL_LABELS_ES[skillId];
  return `${label ?? humanizeSkillId(skillId)} (${skillId})`;
}

export function formatSkillRole(role: AppliedSkillRole): string {
  return role === "primary" ? "principal" : "incluida";
}

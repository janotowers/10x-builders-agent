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
  "compose-message": "Redacción de mensajes",
  "doc-coauthoring": "Coautoría de documentos",
  "errand-planner": "Planeación de pendientes",
  "family-reminders": "Recordatorios personales y familiares",
  "lead-follow-up-draft": "Seguimiento de leads",
  "memory-curate": "Gestión de memoria",
  "personal-day-briefing": "Resumen personal del día",
  "travel-prep": "Preparación de viaje",
};

export function formatSkillForUserPanel(skillId: string): string {
  const label = SKILL_LABELS_ES[skillId];
  return label ? `${label} (${skillId})` : skillId;
}

export function formatSkillRole(role: AppliedSkillRole): string {
  return role === "primary" ? "principal" : "incluida";
}

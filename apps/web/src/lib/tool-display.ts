/**
 * Labels for the chat "tools" sidebar: short Spanish for non-technical users,
 * with the technical id (spaces instead of underscores) in parentheses.
 * Keep in sync with packages/agent/src/tools/catalog.ts tool ids.
 */
const TOOL_LABELS_ES: Record<string, string> = {
  get_user_preferences: "Leer preferencias de tu cuenta",
  list_enabled_tools: "Ver herramientas que tienes activadas",
  github_list_repos: "Listar tus repositorios en GitHub",
  github_list_issues: "Listar issues de un repositorio",
  github_create_repo: "Crear un repositorio en GitHub",
  github_create_issue: "Crear un issue en GitHub",
  calendar_list_calendars: "Listar tus calendarios de Google",
  calendar_list_events: "Consultar eventos en tu Google Calendar",
  calendar_list_tasks: "Consultar tareas en tu Google Calendar",
  calendar_create_event: "Crear un evento en el calendario",
  calendar_update_event: "Actualizar un evento del calendario",
  calendar_delete_event: "Eliminar un evento del calendario",
  read_file: "Leer un archivo del proyecto",
  write_file: "Guardar un archivo en el proyecto",
  edit_file: "Editar un archivo del proyecto",
  schedule_task: "Programar una tarea automática",
  manage_scheduled_tasks: "Ver o pausar tareas programadas",
  read_skill_reference: "Abrir documentación de una habilidad",
  bigquery_run_query: "Consultar datos en BigQuery",
  list_user_memories: "Listar memorias guardadas sobre ti",
  search_user_memories: "Buscar en tus memorias",
  archive_user_memory: "Archivar una memoria",
  delete_user_memory: "Borrar una memoria para siempre",
  bash: "Ejecutar un comando en el servidor",
};

function technicalToolLabel(snakeName: string): string {
  return snakeName.replace(/_/g, " ");
}

/** Single line for UI: "Acción humana (nombre técnico legible)". */
export function formatToolForUserPanel(toolName: string): string {
  const trimmed = toolName.trim();
  const friendly = TOOL_LABELS_ES[trimmed];
  const technical = technicalToolLabel(trimmed);
  if (friendly) return `${friendly} (${technical})`;
  return technical;
}

/** Timestamps con segundos para actividad E2E (resumen por pasos y log técnico). */
export function formatE2EActivityDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

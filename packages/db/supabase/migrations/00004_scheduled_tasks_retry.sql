-- ============================================================
-- scheduled_tasks — retry/backoff policy
-- ============================================================
-- Se añaden dos columnas para soportar reintentos acotados antes de pausar:
--   * consecutive_failures: contador de fallos consecutivos en runs.
--     Se incrementa en cada failure y se reinicia a 0 cuando una ejecución
--     termina ok o el usuario reanuda manualmente la tarea.
--   * last_failure_error: mensaje del último fallo (útil al auto-pausar por
--     N fallos consecutivos; se expone al usuario vía UI/Telegram).
--
-- Safe to re-run: usa IF NOT EXISTS para evitar errores si ya se aplicó.
alter table public.scheduled_tasks
  add column if not exists consecutive_failures int not null default 0;

alter table public.scheduled_tasks
  add column if not exists last_failure_error text;

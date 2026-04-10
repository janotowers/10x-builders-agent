import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  lastUserMessage?: string;
  /** IANA timezone from profile (e.g. America/Mexico_City). */
  userTimezone?: string;
  googleCalendarAccessToken?: string;
}

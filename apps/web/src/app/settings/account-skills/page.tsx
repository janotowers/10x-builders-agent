/**
 * /settings/account-skills
 *
 * UI mínima viable para account_skills V1:
 *   - lista skills (draft, active, archived) con su slug y status.
 *   - botón "nueva" abre un editor textarea con plantilla mínima.
 *   - editar una existente recarga su body_md en el textarea.
 *   - guardar valida frontmatter en el server (POST /api/account-skills);
 *     si falla, se muestra el error.
 *   - eliminar archiva (status=archived).
 *
 * No incluye preview ni diff. Esos se reservan para V2 (ver
 * docs/operational-cases/future-considerations.md sección 6).
 */
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listAccountSkillsForUser, createServerClient } from "@agents/db";
import { AccountSkillsClient } from "./account-skills-client";

export default async function AccountSkillsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const skills = await listAccountSkillsForUser(db, user.id, {
    statuses: ["draft", "active", "archived"],
  });

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">Account skills</h1>
        <p className="mt-1 text-sm text-gray-500">
          Skills propias de esta cuenta. Cuando coinciden por slug con una skill
          global, gana la account. V1: textarea + frontmatter; el preview y el
          versionado completo llegan en V2.
        </p>
      </header>

      <AccountSkillsClient initialSkills={skills} />
    </main>
  );
}

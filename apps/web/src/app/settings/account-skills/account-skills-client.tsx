"use client";

import { useState } from "react";
import type { AccountSkill, AccountSkillStatus } from "@agents/types";

const DEFAULT_TEMPLATE = `---
name: my-account-skill
description: Describe what this skill does, when the agent should pick it, and what it should NOT do. Aim for 1-2 dense sentences.
scope: business
allowed_tools:
  - get_user_preferences
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Hard rules the agent must follow when this skill is active.
---

# My account skill

Workflow body in markdown. Keep it short — load references on demand.
`;

export function AccountSkillsClient({
  initialSkills,
}: {
  initialSkills: AccountSkill[];
}) {
  const [skills, setSkills] = useState<AccountSkill[]>(initialSkills);
  const [editing, setEditing] = useState<{
    slug: string;
    body: string;
    status: AccountSkillStatus;
    isNew: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startNew() {
    setEditing({
      slug: "",
      body: DEFAULT_TEMPLATE,
      status: "draft",
      isNew: true,
    });
    setError(null);
  }

  function startEdit(skill: AccountSkill) {
    setEditing({
      slug: skill.slug,
      body: skill.body_md,
      status: skill.status,
      isNew: false,
    });
    setError(null);
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/account-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: editing.slug.trim(),
          body_md: editing.body,
          status: editing.status,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; skill: AccountSkill }
        | { error: string; details?: string };
      if (!res.ok || !("ok" in data)) {
        setError(
          "details" in data && data.details
            ? `${data.error}: ${data.details}`
            : "error" in data
              ? data.error
              : "save_failed"
        );
        setSaving(false);
        return;
      }
      setSkills((prev) => {
        const without = prev.filter((s) => s.slug !== data.skill.slug);
        return [data.skill, ...without];
      });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function archive(slug: string) {
    if (!confirm(`¿Archivar la skill "${slug}"?`)) return;
    const res = await fetch(`/api/account-skills/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      const data = (await res.json()) as { skill: AccountSkill };
      setSkills((prev) =>
        prev.map((s) => (s.slug === slug ? data.skill : s))
      );
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tus skills</h2>
        <button
          type="button"
          onClick={startNew}
          className="rounded bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
        >
          + Nueva skill
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500">
          Aún no tienes skills propias. Crea una para sobrescribir o
          complementar el catálogo global.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200">
          {skills.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between p-4 text-sm"
            >
              <div className="space-y-1">
                <div className="font-mono font-semibold">{s.slug}</div>
                <div className="text-gray-500">
                  v{s.version} · {s.status} ·{" "}
                  {(s.metadata_jsonb?.scope as string | undefined) ?? "?"}{" "}
                  ·{" "}
                  {(s.metadata_jsonb?.description as string | undefined) ?? ""}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => startEdit(s)}
                  className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50"
                >
                  Editar
                </button>
                {s.status !== "archived" ? (
                  <button
                    type="button"
                    onClick={() => archive(s.slug)}
                    className="rounded border border-red-300 px-3 py-1 text-red-700 hover:bg-red-50"
                  >
                    Archivar
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <div className="space-y-3 rounded border border-gray-300 bg-gray-50 p-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-semibold">Slug:</label>
            <input
              type="text"
              value={editing.slug}
              onChange={(e) =>
                setEditing({ ...editing, slug: e.target.value })
              }
              disabled={!editing.isNew}
              className="flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm disabled:bg-gray-200"
              placeholder="my-account-skill"
            />
            <label className="text-sm font-semibold">Status:</label>
            <select
              value={editing.status}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  status: e.target.value as AccountSkillStatus,
                })
              }
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="archived">archived</option>
            </select>
          </div>
          <textarea
            value={editing.body}
            onChange={(e) =>
              setEditing({ ...editing, body: e.target.value })
            }
            className="h-96 w-full resize-y rounded border border-gray-300 p-2 font-mono text-xs"
          />
          {error ? (
            <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800">
              {error}
            </pre>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-white"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

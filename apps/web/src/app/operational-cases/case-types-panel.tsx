"use client";

import { useState } from "react";
import type { OperationalCaseType } from "@agents/types";

type SkillInfo = {
  source: string;
  kind: string;
  scope: string;
  includes: readonly string[];
  exists: boolean;
};

function skillKindLabel(kind: string) {
  if (kind === "composite") return "compuesta";
  if (kind === "atomic") return "atómica";
  return kind;
}

export function CaseTypesPanel({
  caseTypes,
  skillInfo,
  globalCounterpartBySlug = {},
}: {
  caseTypes: OperationalCaseType[];
  skillInfo: Record<string, SkillInfo>;
  /**
   * Si el case_type mostrado es una versión de cuenta, este map contiene la
   * versión de producto que oculta. Sirve para indicar al usuario que está
   * viendo una personalización, no una duplicación.
   */
  globalCounterpartBySlug?: Record<string, OperationalCaseType>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="text-base font-semibold">Plantillas de flujos disponibles</h2>
      <div className="mt-3 space-y-3">
        {caseTypes.map((type) => {
          const info = skillInfo[type.default_skill_slug] ?? {
            source: "global",
            kind: "atomic",
            scope: "business",
            includes: [],
            exists: false,
          };
          const isExpanded = expanded[type.id] ?? false;
          const shouldToggle = (type.description?.length ?? 0) > 140;
          const customizesProduct = Boolean(
            type.user_id && globalCounterpartBySlug[type.case_type]
          );

          return (
            <div
              key={type.id}
              className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{type.display_name}</span>
                {customizesProduct ? (
                  <span
                    className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700"
                    title="Esta versión de cuenta personaliza el caso de uso de producto con el mismo identificador. Cuando ambos existen, la versión de cuenta es la que se usa."
                  >
                    Personaliza versión de producto
                  </span>
                ) : null}
              </div>
              <div className="mt-2 grid gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                <div>
                  <span className="font-medium">Identificador técnico:</span>{" "}
                  <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {type.case_type}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Origen de caso de uso:</span>{" "}
                  <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {type.user_id ? "cuenta" : "producto"}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Habilidad asociada:</span>{" "}
                  <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {type.default_skill_slug}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Origen de habilidad:</span>{" "}
                  <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {info.source === "account" ? "cuenta" : "producto"}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Tipo de habilidad:</span>{" "}
                  <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                    {skillKindLabel(info.kind)}
                  </span>
                </div>
              </div>
              {type.description ? (
                <div className="mt-3 text-xs leading-relaxed text-neutral-500">
                  <p className={isExpanded ? "" : "line-clamp-2"}>
                    {type.description}
                  </p>
                  {shouldToggle ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [type.id]: !isExpanded,
                        }))
                      }
                      className="mt-1 text-xs font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300"
                    >
                      {isExpanded ? "Ver menos" : "Ver descripción completa"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export type AppNavMatcher =
  | "chat-conversation"
  | "chat-pending"
  | { kind: "settings-view"; view: string }
  /** Activo cuando el pathname empieza con cualquiera de los prefijos. */
  | { kind: "path-prefix"; prefixes: string[] };

export type AppNavNode = {
  key: string;
  label: string;
  shortLabel?: string;
  icon:
    | "chat"
    | "bell"
    | "flow"
    | "template"
    | "pulse"
    | "clock"
    | "memory"
    | "user"
    | "agent"
    | "sliders"
    | "spark"
    | "tool"
    | "plug"
    | "channel"
    | "key"
    | "account"
    | "usage";
  href?: string;
  matcher?: AppNavMatcher;
  /** Only shown when `profiles.is_ungga_admin` is true. */
  adminOnly?: boolean;
  children?: AppNavNode[];
};

export const APP_NAV_TREE: AppNavNode[] = [
  {
    key: "chat",
    label: "Chat",
    icon: "chat",
    children: [
      {
        key: "conversation",
        label: "Conversación",
        shortLabel: "Conv",
        icon: "chat",
        href: "/chat",
        matcher: "chat-conversation",
      },
      {
        key: "pending",
        label: "Pendientes",
        shortLabel: "Pend",
        icon: "bell",
        href: "/chat/pending",
        matcher: "chat-pending",
      },
    ],
  },
  {
    key: "operations",
    label: "Operaciones",
    icon: "flow",
    children: [
      {
        key: "running-flows",
        label: "Casos en curso",
        shortLabel: "Casos",
        icon: "flow",
        href: "/operational-cases",
      },
      {
        key: "proactivity",
        label: "Proactividad",
        shortLabel: "Proact",
        icon: "pulse",
        href: "/settings?view=proactivity&section=pulse",
        matcher: { kind: "settings-view", view: "proactivity" },
      },
      {
        // Superficie unificada del operador (consolidación de navegación,
        // inicio de Phase 4): /operations/work y /operations/impact son
        // pestañas de "Control operativo". Mismo rol interino is_ungga_admin
        // (Technical Plan §16 deja abierto el sistema de roles).
        key: "operations-control",
        label: "Control operativo",
        shortLabel: "Control",
        icon: "tool",
        href: "/operations/work",
        matcher: {
          kind: "path-prefix",
          prefixes: ["/operations/work", "/operations/impact"],
        },
        adminOnly: true,
      },
      {
        // Workflow Studio (Slice 4.2-4): absorbe "Plantillas de flujos" y
        // "Workflows" en una sola entrada (acuerdo de navegación 4.0-4).
        // Pestañas: Catálogo / Diseño / Recursos. El laboratorio de
        // /settings/operational-case-types sigue accesible desde el Studio
        // para diagnósticos (readiness de tools, pruebas E2E) mientras migra.
        // Sin gate de admin: todo es lectura/escritura del propio tenant.
        key: "workflow-studio",
        label: "Diseño de flujos",
        shortLabel: "Diseño",
        icon: "template",
        href: "/operations/workflows",
        matcher: {
          kind: "path-prefix",
          prefixes: ["/operations/workflows", "/settings/operational-case-types"],
        },
      },
    ],
  },
  {
    key: "knowledge",
    label: "Conocimiento",
    icon: "memory",
    children: [{ key: "memory", label: "Memoria", shortLabel: "Memo", icon: "memory", href: "/memory" }],
  },
  {
    key: "settings",
    label: "Configuración",
    icon: "sliders",
    children: [
      {
        key: "profile-user",
        label: "Perfil del usuario",
        shortLabel: "Perfil",
        icon: "user",
        href: "/settings?view=profile-user#profile-user",
        matcher: { kind: "settings-view", view: "profile-user" },
      },
      {
        key: "profile-agent",
        label: "Perfil del agente",
        shortLabel: "Agente",
        icon: "agent",
        href: "/settings?view=profile-agent#profile-agent",
        matcher: { kind: "settings-view", view: "profile-agent" },
      },
      {
        key: "capabilities",
        label: "Capacidades del agente",
        shortLabel: "Cap",
        icon: "sliders",
        href: "/settings?view=capabilities&section=skills",
        matcher: { kind: "settings-view", view: "capabilities" },
      },
      {
        key: "integrations",
        label: "Integraciones",
        shortLabel: "Int",
        icon: "plug",
        href: "/settings?view=integrations&section=connections",
        matcher: { kind: "settings-view", view: "integrations" },
      },
      {
        key: "ai-usage",
        label: "Uso de IA",
        shortLabel: "Uso IA",
        icon: "usage",
        href: "/settings/ai-usage",
        adminOnly: true,
      },
      {
        key: "account-session",
        label: "Cuenta y sesión",
        shortLabel: "Cuenta",
        icon: "account",
        href: "/settings?view=account-session#account-session",
        matcher: { kind: "settings-view", view: "account-session" },
      },
    ],
  },
];

/** Filters admin-only nodes when the viewer is not an Ungga admin. */
export function resolveAppNavTree(isUnggaAdmin: boolean): AppNavNode[] {
  const keep = (node: AppNavNode): AppNavNode | null => {
    if (node.adminOnly && !isUnggaAdmin) return null;
    if (!node.children?.length) return node;
    const children = node.children
      .map(keep)
      .filter((child): child is AppNavNode => child != null);
    if (children.length === 0 && !node.href) return null;
    return { ...node, children };
  };
  return APP_NAV_TREE.map(keep).filter(
    (node): node is AppNavNode => node != null
  );
}


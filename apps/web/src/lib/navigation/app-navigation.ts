export type AppNavMatcher =
  | "chat-conversation"
  | "chat-pending"
  | { kind: "settings-view"; view: string };

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
    | "account";
  href?: string;
  matcher?: AppNavMatcher;
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
        href: "/chat?pendientes=1",
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
        label: "Flujos en curso",
        shortLabel: "Flujos",
        icon: "flow",
        href: "/operational-cases",
      },
      {
        key: "flow-templates",
        label: "Plantillas de flujos",
        shortLabel: "Plant",
        icon: "template",
        href: "/settings/operational-case-types",
      },
    ],
  },
  {
    key: "proactivity",
    label: "Proactividad",
    icon: "pulse",
    href: "/settings?view=proactivity&section=pulse",
    matcher: { kind: "settings-view", view: "proactivity" },
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


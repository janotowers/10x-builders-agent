export type SettingsView =
  | "profile-user"
  | "profile-agent"
  | "capabilities"
  | "integrations"
  | "proactivity"
  | "account-session";

export function isSettingsView(value: string | null | undefined): value is SettingsView {
  return (
    value === "profile-user" ||
    value === "profile-agent" ||
    value === "capabilities" ||
    value === "integrations" ||
    value === "proactivity" ||
    value === "account-session"
  );
}

export function getSettingsPageMeta(
  viewParam: string | null | undefined,
  sectionParam: string | null | undefined
): { title: string; description: string } {
  const view: SettingsView = isSettingsView(viewParam) ? viewParam : "profile-user";
  const section = sectionParam ?? "";

  switch (view) {
    case "profile-user":
      return {
        title: "Perfil de usuario",
        description:
          "Datos de contacto, avatar y zona horaria que el agente conoce de ti.",
      };
    case "profile-agent":
      return {
        title: "Perfil del agente",
        description:
          "Define identidad, voz, contexto y preferencias del colaborador IA. Las reglas de seguridad y permisos siempre tienen prioridad.",
      };
    case "capabilities":
      if (section === "requests") {
        return {
          title: "Solicitudes de herramientas",
          description:
            "Backlog creado desde Preparación operativa cuando una herramienta requiere configuración, un recurso de cuenta o prioridad de producto.",
        };
      }
      if (section === "tools") {
        return {
          title: "Herramientas permitidas",
          description:
            "El color indica el nivel de riesgo operativo de cada herramienta. Las reglas de confirmación y permisos siguen aplicándose siempre.",
        };
      }
      return {
        title: "Habilidades activadas",
        description:
          "Playbooks que el agente puede activar según la intención del turno.",
      };
    case "integrations":
      if (section === "channels") {
        return {
          title: "Canales",
          description:
            "Canales conversacionales donde puedes hablar con el agente, como Telegram.",
        };
      }
      if (section === "credentials") {
        return {
          title: "Credenciales API",
          description:
            "API keys y tokens propios de tu cuenta, cifrados antes de guardarse.",
        };
      }
      return {
        title: "Conexiones",
        description:
          "Servicios externos conectados por OAuth o autorización directa, como Google Calendar y GitHub.",
      };
    case "proactivity":
      if (section === "tasks") {
        return {
          title: "Tareas programadas",
          description:
            "Automatizaciones que pediste a Gu. Se ejecutan por cron y son distintas del pulso operativo.",
        };
      }
      if (section === "delivery-policies") {
        return {
          title: "Políticas de entrega",
          description:
            "Configuración global de recordatorios, escalaciones y ventanas horarias para avisos al asesor y contactos externos.",
        };
      }
      return {
        title: "Pulso operativo",
        description:
          "Rutina periódica del agente cuando no hay un mensaje manual. En esta etapa se ejecuta en modo seguro (solo lectura).",
      };
    case "account-session":
      return {
        title: "Cuenta y sesión",
        description:
          "Acceso, seguridad y cierre de sesión de tu cuenta UNGGA.",
      };
  }
}

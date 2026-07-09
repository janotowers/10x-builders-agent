"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

function loginErrorMessage(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message.trim() : "";
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;

  if (!message || message === "{}") {
    if (status === 504) {
      return "El servicio de autenticacion no respondio a tiempo. Intenta de nuevo en unos minutos.";
    }
    return "No se pudo iniciar sesion. Revisa tu conexion e intenta de nuevo.";
  }

  if (status === 504 || /timeout|timed out/i.test(message)) {
    return "El servicio de autenticacion no respondio a tiempo. Intenta de nuevo en unos minutos.";
  }
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "Correo o contrasena incorrectos.";
  }
  if (/fetch|network|failed to fetch/i.test(message)) {
    return "No se pudo conectar con el servicio de autenticacion. Revisa tu conexion e intenta de nuevo.";
  }

  return message;
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(loginErrorMessage(error));
        setLoading(false);
        return;
      }
    } catch (err) {
      setError(loginErrorMessage(err));
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          Correo electrónico
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium mb-1">
          Contraseña
        </label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "Ingresando..." : "Iniciar sesión"}
      </button>
    </form>
  );
}

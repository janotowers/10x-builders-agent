import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  stat,
} from "node:fs/promises";
import path from "node:path";

const MAX_READ_BYTES = 1_000_000;
const MAX_READ_LINES = 5_000;
const MAX_WRITE_BYTES = 1_000_000;

type OkResult = { ok: true } & Record<string, unknown>;
type ErrResult = {
  ok: false;
  tool: string;
  path?: string;
  error: { code: string; message: string };
};

function err(
  tool: string,
  code: string,
  message: string,
  resolvedPath?: string
): ErrResult {
  return {
    ok: false,
    tool,
    ...(resolvedPath ? { path: resolvedPath } : {}),
    error: { code, message },
  };
}

function requireEnabled(
  tool: string
): { ok: true; root: string } | ErrResult {
  if (process.env.FILE_TOOLS_ENABLED !== "true") {
    return err(
      tool,
      "tool_disabled",
      "Las herramientas de archivos están desactivadas en el servidor. Define FILE_TOOLS_ENABLED=true."
    );
  }
  const raw = process.env.FILE_TOOLS_ROOT?.trim();
  if (!raw) {
    return err(
      tool,
      "missing_root",
      "FILE_TOOLS_ROOT no está definido. Configura la ruta absoluta del workspace permitido."
    );
  }
  const root = path.resolve(raw);
  return { ok: true, root };
}

export function resolveSafePath(
  userPath: string,
  root: string
): { ok: true; resolved: string } | { ok: false; message: string } {
  if (!userPath || typeof userPath !== "string") {
    return { ok: false, message: "path es obligatorio y debe ser string." };
  }
  if (userPath.includes("\0")) {
    return { ok: false, message: "path contiene caracteres inválidos." };
  }
  if (path.isAbsolute(userPath)) {
    return {
      ok: false,
      message:
        "path debe ser RELATIVO al workspace (FILE_TOOLS_ROOT). No uses rutas absolutas.",
    };
  }
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
    return {
      ok: false,
      message: `path escapa del workspace permitido (${normalizedRoot}).`,
    };
  }
  return { ok: true, resolved };
}

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export async function executeReadFile(
  input: ReadFileInput
): Promise<OkResult | ErrResult> {
  const gate = requireEnabled("read_file");
  if ("ok" in gate && gate.ok !== true) return gate;
  const { root } = gate as { ok: true; root: string };

  const safe = resolveSafePath(input.path, root);
  if (!safe.ok) {
    return err("read_file", "invalid_path", safe.message);
  }

  try {
    const st = await stat(safe.resolved);
    if (st.isDirectory()) {
      return err(
        "read_file",
        "is_directory",
        "La ruta apunta a un directorio, no a un archivo.",
        safe.resolved
      );
    }
    if (st.size > MAX_READ_BYTES) {
      return err(
        "read_file",
        "file_too_large",
        `El archivo supera el tope de lectura (${MAX_READ_BYTES} bytes).`,
        safe.resolved
      );
    }

    const raw = await fsReadFile(safe.resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;

    const hasOffset =
      typeof input.offset === "number" && Number.isFinite(input.offset);
    const hasLimit =
      typeof input.limit === "number" && Number.isFinite(input.limit);

    let startLine = 1;
    let endLine = Math.min(totalLines, MAX_READ_LINES);
    if (hasOffset) {
      startLine = Math.max(1, Math.floor(input.offset as number));
    }
    if (hasLimit) {
      const limit = Math.max(1, Math.floor(input.limit as number));
      endLine = Math.min(totalLines, startLine + limit - 1);
    } else if (!hasOffset) {
      endLine = Math.min(totalLines, MAX_READ_LINES);
    } else {
      endLine = Math.min(totalLines, startLine + MAX_READ_LINES - 1);
    }

    const slice = lines.slice(startLine - 1, endLine).join("\n");

    return {
      ok: true,
      tool: "read_file",
      path: safe.resolved,
      content: slice,
      startLine,
      endLine,
      totalLines,
      truncated: endLine < totalLines,
    };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return err(
        "read_file",
        "not_found",
        "El archivo no existe.",
        safe.resolved
      );
    }
    if (code === "EACCES") {
      return err(
        "read_file",
        "permission_denied",
        "Sin permisos para leer el archivo.",
        safe.resolved
      );
    }
    return err(
      "read_file",
      "read_failed",
      (e as Error)?.message ?? "Error leyendo el archivo.",
      safe.resolved
    );
  }
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export async function executeWriteFile(
  input: WriteFileInput
): Promise<OkResult | ErrResult> {
  const gate = requireEnabled("write_file");
  if ("ok" in gate && gate.ok !== true) return gate;
  const { root } = gate as { ok: true; root: string };

  const safe = resolveSafePath(input.path, root);
  if (!safe.ok) {
    return err("write_file", "invalid_path", safe.message);
  }
  if (typeof input.content !== "string") {
    return err(
      "write_file",
      "invalid_content",
      "content debe ser string UTF-8.",
      safe.resolved
    );
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    return err(
      "write_file",
      "content_too_large",
      `content supera el tope (${MAX_WRITE_BYTES} bytes).`,
      safe.resolved
    );
  }

  try {
    let existed = false;
    try {
      const st = await stat(safe.resolved);
      if (st.isDirectory()) {
        return err(
          "write_file",
          "is_directory",
          "La ruta apunta a un directorio existente.",
          safe.resolved
        );
      }
      existed = true;
    } catch {
      existed = false;
    }

    await mkdir(path.dirname(safe.resolved), { recursive: true });
    await fsWriteFile(safe.resolved, input.content, "utf8");

    return {
      ok: true,
      tool: "write_file",
      path: safe.resolved,
      bytesWritten: bytes,
      created: !existed,
      overwritten: existed,
    };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EACCES") {
      return err(
        "write_file",
        "permission_denied",
        "Sin permisos para escribir.",
        safe.resolved
      );
    }
    return err(
      "write_file",
      "write_failed",
      (e as Error)?.message ?? "Error escribiendo el archivo.",
      safe.resolved
    );
  }
}

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
}

export async function executeEditFile(
  input: EditFileInput
): Promise<OkResult | ErrResult> {
  const gate = requireEnabled("edit_file");
  if ("ok" in gate && gate.ok !== true) return gate;
  const { root } = gate as { ok: true; root: string };

  const safe = resolveSafePath(input.path, root);
  if (!safe.ok) {
    return err("edit_file", "invalid_path", safe.message);
  }
  if (typeof input.old_string !== "string" || input.old_string.length === 0) {
    return err(
      "edit_file",
      "invalid_old_string",
      "old_string es obligatorio y no puede estar vacío.",
      safe.resolved
    );
  }
  if (typeof input.new_string !== "string") {
    return err(
      "edit_file",
      "invalid_new_string",
      "new_string debe ser string.",
      safe.resolved
    );
  }

  try {
    const st = await stat(safe.resolved);
    if (st.isDirectory()) {
      return err(
        "edit_file",
        "is_directory",
        "La ruta apunta a un directorio.",
        safe.resolved
      );
    }
    if (st.size > MAX_READ_BYTES) {
      return err(
        "edit_file",
        "file_too_large",
        `El archivo supera el tope de edición (${MAX_READ_BYTES} bytes).`,
        safe.resolved
      );
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return err(
        "edit_file",
        "not_found",
        "El archivo no existe. Usa write_file para crear archivos nuevos.",
        safe.resolved
      );
    }
    return err(
      "edit_file",
      "stat_failed",
      (e as Error)?.message ?? "No se pudo acceder al archivo.",
      safe.resolved
    );
  }

  try {
    const content = await fsReadFile(safe.resolved, "utf8");
    const idx = content.indexOf(input.old_string);
    if (idx === -1) {
      return err(
        "edit_file",
        "no_match",
        "old_string no apareció en el archivo. Copia literalmente el fragmento (incluye espacios y saltos de línea).",
        safe.resolved
      );
    }
    const idx2 = content.indexOf(input.old_string, idx + 1);
    if (idx2 !== -1) {
      return err(
        "edit_file",
        "multiple_matches",
        "old_string aparece más de una vez. Amplía el contexto para que sea único.",
        safe.resolved
      );
    }

    const updated =
      content.slice(0, idx) +
      input.new_string +
      content.slice(idx + input.old_string.length);

    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
      return err(
        "edit_file",
        "content_too_large",
        `El resultado supera el tope (${MAX_WRITE_BYTES} bytes).`,
        safe.resolved
      );
    }

    await fsWriteFile(safe.resolved, updated, "utf8");
    return {
      ok: true,
      tool: "edit_file",
      path: safe.resolved,
      replacements: 1,
      bytesWritten: Buffer.byteLength(updated, "utf8"),
    };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EACCES") {
      return err(
        "edit_file",
        "permission_denied",
        "Sin permisos para editar.",
        safe.resolved
      );
    }
    return err(
      "edit_file",
      "edit_failed",
      (e as Error)?.message ?? "Error editando el archivo.",
      safe.resolved
    );
  }
}

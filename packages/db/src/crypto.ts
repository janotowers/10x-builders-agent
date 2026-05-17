import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64)
    throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  const decipher = createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(ctHex, "hex", "utf8") + decipher.final("utf8");
}

/**
 * Convenience helpers para guardar/leer objetos JSON cifrados. Usado por
 * `account_tool_secrets.encrypted_secret_jsonb` y futuras tablas que
 * necesiten almacenar payloads heterogéneos cifrados sin esquema fijo.
 *
 * NO devuelve `unknown` para no forzar a cada call site a aserciones;
 * cada provider conoce la forma esperada y debería validarla al leer.
 */
export function encryptJson(value: unknown): string {
  return encryptToken(JSON.stringify(value));
}

export function decryptJson<T = unknown>(stored: string): T {
  return JSON.parse(decryptToken(stored)) as T;
}

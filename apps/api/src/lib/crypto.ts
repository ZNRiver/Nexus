import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const ENC_PREFIX = "enc:v1:";

function deriveKey(secret: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Buffer.from(secret, "hex");
  }
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a value at rest (AES-256-GCM). */
export function encrypt(plaintext: string, keySecret: string): string {
  const key = deriveKey(keySecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string, keySecret: string): string {
  if (!payload.startsWith(ENC_PREFIX)) return payload;
  const key = deriveKey(keySecret);
  const raw = Buffer.from(payload.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/** SHA-256 hash for session tokens / agent tokens (never stored raw). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function mask(value: string, keep = 3): string {
  if (value.length <= keep + 4) return "*".repeat(value.length);
  return `${value.slice(0, keep)}${"•".repeat(8)}${value.slice(-2)}`;
}

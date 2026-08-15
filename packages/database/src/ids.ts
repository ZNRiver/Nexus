/**
 * Prefixed, sortable-ish unique ids: `usr_01HX...`.
 * Collision-safe via random 12 bytes; prefix makes resources identifiable.
 */

export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i]! % alphabet.length];
  return `${prefix}_${s}`;
}

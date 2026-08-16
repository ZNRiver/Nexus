/** Replace values of secret keys in a raw .env text with dots, keeping comments and ordering. */
export function maskEnvTextSecrets(text: string, secretKeys: Set<string>): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return line;
      const key = trimmed.slice(0, eq).trim();
      if (!secretKeys.has(key)) return line;
      const value = trimmed.slice(eq + 1);
      if (value.length === 0) return line;
      if (/^[\u2022*]+$/.test(value.trim())) return line; // already masked
      return `${trimmed.slice(0, eq + 1)}${String.fromCharCode(0x2022).repeat(Math.max(6, value.length))}`;
    })
    .join("\n");
}

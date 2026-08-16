import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { post, put } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EnvironmentVariable } from "@nexus/types";

/** Build the editor text (KEY=VALUE per line, values masked) from the API list. */
function buildEnvText(envs: EnvironmentVariable[], reveal: Record<string, string>, mask: boolean): string {
  return envs
    .map((e) => {
      // When masked, show dots for every line (regardless of per-line reveal).
      const value = mask ? "••••••••••••" : (reveal[e.id] ?? e.valueMasked);
      return `${e.key}=${value}`;
    })
    .join("\n");
}

/** Replace the values of secret keys in a raw env text with dots, keeping comments and ordering. */
function maskSecretLines(text: string, secretKeys: Record<string, boolean>): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return line;
      const key = trimmed.slice(0, eq).trim();
      if (!secretKeys[key]) return line;
      const value = trimmed.slice(eq + 1);
      if (value.length === 0) return line;
      if (/^[\u2022*]+$/.test(value.trim())) return line; // already masked
      return `${trimmed.slice(0, eq + 1)}${String.fromCharCode(0x2022).repeat(Math.max(6, value.length))}`;
    })
    .join("\n");
}

/**
 * Raw .env editor that preserves comments and line order. Secret values are
 * shown as dots until Reveal, stay encrypted at rest, and saving with dots
 * keeps the stored value. Used by the application and database detail pages.
 */
export function EnvTextEditor({
  items,
  environmentText,
  resourceId,
  saveUrl,
  revealUrl,
  onSaved,
}: {
  items?: EnvironmentVariable[];
  environmentText?: string | null;
  resourceId: string;
  saveUrl: (id: string) => string;
  revealUrl: (id: string, envId: string) => string;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [envText, setEnvText] = useState("");
  const [envInit, setEnvInit] = useState(false);
  const [envMasked, setEnvMasked] = useState(true);
  const [envSecretKeys, setEnvSecretKeys] = useState<Record<string, boolean>>({});
  const [revealedEnv, setRevealedEnv] = useState<Record<string, string>>({});
  const [savingEnv, setSavingEnv] = useState(false);
  const envGutterRef = useRef<HTMLDivElement>(null);
  const envEditorRef = useRef<HTMLTextAreaElement>(null);

  // Initialize the editor once the env list arrives — prefer the stored raw .env text.
  useEffect(() => {
    if (!envInit && (environmentText != null || items)) {
      setEnvText(environmentText ?? buildEnvText(items ?? [], revealedEnv, true));
      setEnvSecretKeys(Object.fromEntries((items ?? []).map((e) => [e.key, e.isSecret])));
      setEnvInit(true);
    }
  }, [items, environmentText, envInit]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealEnv = async (env: EnvironmentVariable) => {
    try {
      const res = await post<{ value: string }>(revealUrl(resourceId, env.id));
      setRevealedEnv((r) => ({ ...r, [env.id]: res.value }));
      // Swap the masked dots for the real value on that line only, keeping comments and order.
      setEnvText((text) =>
        text
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            const eq = trimmed.indexOf("=");
            if (eq <= 0) return line;
            if (trimmed.slice(0, eq).trim() !== env.key) return line;
            const value = trimmed.slice(eq + 1);
            if (!/^[\u2022*]+$/.test(value.trim())) return line; // only swap masked values
            return `${trimmed.slice(0, eq + 1)}${res.value}`;
          })
          .join("\n"),
      );
    } catch (err) {
      toast("error", "Reveal failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const toggleEnvMasked = async () => {
    if (envMasked && items) {
      // Reveal ALL variables (secret or not) with a single click.
      await Promise.all(items.filter((e) => !revealedEnv[e.id]).map((e) => revealEnv(e).catch(() => {})));
      setEnvMasked(false);
    } else {
      setEnvMasked(true);
      // Re-mask every secret line in place, keeping comments and ordering.
      setEnvText((text) => maskSecretLines(text, envSecretKeys));
      setRevealedEnv({});
    }
  };

  /** Save the whole editor back to the backend (diff → upsert/delete + raw text). */
  const saveEnv = async () => {
    const variables = envText
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) return null;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
        return { key, value, isSecret: !!envSecretKeys[key] };
      })
      .filter((v): v is { key: string; value: string; isSecret: boolean } => v !== null);
    setSavingEnv(true);
    try {
      await put(saveUrl(resourceId), { variables, rawText: envText });
      toast("success", "Environment saved", `${variables.length} variables`);
      onSaved?.();
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingEnv(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle className="text-sm">Environment Settings</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">You can add environment variables to your resource. Edit the file below — one <code className="rounded bg-muted px-1 font-mono">KEY=VALUE</code> per line.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void toggleEnvMasked()} title={envMasked ? "Reveal secret values" : "Hide secret values"}>
            {envMasked ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {envMasked ? "Reveal" : "Hide"}
          </Button>
          <Button size="sm" onClick={saveEnv} disabled={savingEnv}>
            {savingEnv ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-3.5" />} Save
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-xl border border-border/60">
          <div className="flex">
            {/* line-number gutter */}
            <div
              ref={envGutterRef}
              className="select-none overflow-hidden border-r border-border/40 bg-muted/40 px-3 py-3 text-right font-mono text-[12px] leading-6 text-muted-foreground/50"
              aria-hidden="true"
            >
              {envText.split("\n").map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={envEditorRef}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              onScroll={() => {
                if (envGutterRef.current && envEditorRef.current) {
                  envGutterRef.current.scrollTop = envEditorRef.current.scrollTop;
                }
              }}
              spellCheck={false}
              placeholder="DATABASE_URL=postgres://user:pass@db:5432/app"
              className="min-h-[240px] w-full flex-1 resize-y bg-muted/20 py-3 pr-3 font-mono text-[12px] leading-6 text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Comments (<code className="rounded bg-muted px-1 font-mono">#</code>) and line order are preserved. Secrets stay encrypted at rest and are shown as dots until you press Reveal — saving with dots keeps the stored value.
        </p>
      </CardContent>
    </Card>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { onDashboardReconnect, sendDashboard, subscribeDashboard } from "./ws";

export interface UseLiveLogsOptions {
  /** mount the stream only when true (e.g. the tab is active) */
  enabled: boolean;
  /** unique stream id (e.g. `game:gme_xxx`); null disables streaming */
  streamId: string | null;
  kind: "game" | "database" | "application";
  /** resource id (game server / database / application id) */
  id: string;
  /** REST fetch of the last N log lines (used as seed + catch-up) */
  seed: () => Promise<string>;
}

export interface UseLiveLogsResult {
  /** current full log text (seeded from REST, appended live via WS) */
  text: string;
  /** whether the WS stream is actively delivering lines right now */
  live: boolean;
  /** force a re-seed from REST (e.g. right after sending a command) */
  resync: () => Promise<void>;
  /** inject synthetic lines (echoed command + RCON output) into the live buffer */
  append: (lines: string[], kind?: "cmd" | "out" | "err") => void;
  /** wipe the buffer (Pterodactyl-style: cleared when the server stops/restarts) */
  clear: () => void;
}

// Control markers so parseLogs can style injected lines (command echo, RCON
// output, errors) the same way it styles real container log lines.
export const INJ_CMD = "\u0001";
export const INJ_OUT = "\u0002";
export const INJ_ERR = "\u0003";

/** Wrap a line with a marker so the console can color it correctly. */
export function markInjected(kind: "cmd" | "out" | "err", line: string): string {
  const m = kind === "cmd" ? INJ_CMD : kind === "err" ? INJ_ERR : INJ_OUT;
  return `${m}${line}`;
}

/**
 * Live container logs: seed the tail from REST, then append lines streamed by
 * the agent through the dashboard WebSocket. While the stream is alive there is
 * NO polling; only after the stream ends (container/agent down) a slow 10s
 * recovery poll re-seeds and re-subscribes until lines flow again.
 */
export function useLiveLogs({ enabled, streamId, kind, id, seed }: UseLiveLogsOptions): UseLiveLogsResult {
  const [text, setText] = useState("");
  const [live, setLive] = useState(false);
  const textRef = useRef("");
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const resync = useCallback(async () => {
    try {
      const t = await seedRef.current();
      textRef.current = t;
      setText(t);
    } catch {
      /* keep current buffer on seed failure */
    }
  }, []);

  /**
   * Inject synthetic lines straight into the live buffer (command echo, RCON
   * response, exec errors) so they appear on the same timeline as the
   * container logs. Dedups against the recent tail so lines the server already
   * printed (e.g. RCON echoes the command) don't appear twice.
   */
  const append = useCallback((lines: string[], kind: "cmd" | "out" | "err" = "out") => {
    if (!lines.length) return;
    const recent = textRef.current.split("\n").slice(-30).map((l) => l.trim().toLowerCase());
    const out: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (recent.includes(line.toLowerCase())) continue; // already on screen
      out.push(markInjected(kind, line));
      recent.push(line.toLowerCase());
    }
    if (!out.length) return;
    textRef.current = textRef.current ? `${textRef.current}\n${out.join("\n")}` : out.join("\n");
    setText(textRef.current);
  }, []);

  /** Wipe the buffer entirely (e.g. the server was stopped or restarted). */
  const clear = useCallback(() => {
    textRef.current = "";
    setText("");
  }, []);

  // Subscribe / unsubscribe the WS stream.
  useEffect(() => {
    if (!enabled || !streamId) {
      setLive(false);
      return;
    }
    const subscribe = () => sendDashboard({ type: "subscribe", streamId, kind, id, tail: 200 });
    subscribe();
    void resync();

    const offReconnect = onDashboardReconnect(() => {
      // The old stream died with the connection — re-seed and re-subscribe.
      void resync();
      subscribe();
    });
    const off = subscribeDashboard((ev) => {
      if (ev.type !== "container.log" || ev.streamId !== streamId) return;
      if (ev.ended) {
        setLive(false);
        return;
      }
      setLive(true);
      textRef.current = textRef.current ? `${textRef.current}\n${ev.line}` : ev.line;
      setText(textRef.current);
    });
    return () => {
      sendDashboard({ type: "unsubscribe", streamId });
      off();
      offReconnect();
    };
  }, [enabled, streamId, kind, id, resync]);

  // Recovery: while the stream is dead, slowly re-seed + re-subscribe so a
  // restarted container/agent resumes instantly with no 5s polling.
  useEffect(() => {
    if (!enabled || !streamId || live) return;
    const t = setInterval(() => {
      void resync();
      sendDashboard({ type: "subscribe", streamId, kind, id, tail: 200 });
    }, 10000);
    return () => clearInterval(t);
  }, [enabled, streamId, kind, id, live, resync]);

  return { text, live, resync, append, clear };
}

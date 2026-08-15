import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dim" | "dark";
type ResolvedTheme = "light" | "dim" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function resolveTheme(t: Theme): ResolvedTheme {
  if (t === "light" || t === "dim" || t === "dark") return t;
  return "light";
}

const PAGE_BG: Record<ResolvedTheme, string> = { light: "#f9f9fb", dim: "#141416", dark: "#000000" };

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.backgroundColor = PAGE_BG[resolved];
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [resolvedTheme, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const t: Theme = stored === "light" || stored === "dim" || stored === "dark" ? stored : "light";
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    applyTheme(resolved);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    const resolved = resolveTheme(t);
    setThemeState(t);
    setResolved(resolved);
    localStorage.setItem("theme", t);
    applyTheme(resolved);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = resolvedTheme === "light" ? "dim" : resolvedTheme === "dim" ? "dark" : "light";
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

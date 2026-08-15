import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { get } from "@/lib/api";
import type { AuthMe } from "@nexus/types";

interface AuthContextValue {
  user: AuthMe["user"] | null;
  setup: AuthMe["setup"];
  loading: boolean;
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  setup: { completed: false, adminCreated: false, localServerCreated: false },
  loading: true,
  refetch: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthMe["user"] | null>(null);
  const [setup, setSetup] = useState<AuthMe["setup"]>({ completed: false, adminCreated: false, localServerCreated: false });
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const data = await get<AuthMe>("/auth/me");
      setUser(data.user);
      setSetup(data.setup);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refetch().finally(() => setLoading(false));
  }, [refetch]);

  return <AuthContext.Provider value={{ user, setup, loading, refetch }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { randomUUID } from "@/lib/random-uuid";
import { cn } from "@/lib/utils";

type ToastType = "error" | "success" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  title?: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, title?: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const DURATION = 4500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: ToastType, message: string, title?: string) => {
    const id = randomUUID();
    let added = false;
    setToasts((prev) => {
      if (prev.some((t) => t.type === type && t.message === message && t.title === title)) return prev;
      added = true;
      return [...prev, { id, type, message, title }];
    });
    if (added) {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), DURATION);
    }
  }, []);

  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const icons: Record<ToastType, React.ReactNode> = {
    error: <XCircle className="size-4 text-destructive shrink-0" />,
    success: <CheckCircle2 className="size-4 text-success shrink-0" />,
    info: <Info className="size-4 text-muted-foreground shrink-0" />,
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 end-5 z-[2147483647] flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="alert"
              onClick={() => dismiss(t.id)}
              className={cn(
                "flex min-w-[300px] max-w-[400px] cursor-pointer items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-sm shadow-xl animate-slide-in-up transition-all duration-200 hover:shadow-2xl",
                t.type === "error" && "border-destructive/40",
                t.type === "success" && "border-success/40",
                t.type === "info" && "border-border",
              )}
            >
              {icons[t.type]}
              <div className="min-w-0 flex-1">
                {t.title && <p className="font-semibold leading-snug">{t.title}</p>}
                <p className="break-words leading-relaxed text-muted-foreground">{t.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

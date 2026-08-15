import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  eventId: string;
}

/**
 * Global error boundary — catches render errors anywhere below it and shows a
 * friendly screen with a reload button instead of a blank page. The error is
 * also surfaced to the console so it can be diagnosed from DevTools.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, eventId: "" };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, eventId: Math.random().toString(36).slice(2, 10) };
  }

  override componentDidCatch(error: Error, info: unknown): void {
    // Keep the original error visible for debugging.
    console.error("[ErrorBoundary] Uncaught render error", error, info);
  }

  private reset = (): void => {
    this.setState({ error: null, eventId: "" });
  };

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <Logo size={44} />
          <div className="mt-8 flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertTriangle className="size-7" />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The panel hit an unexpected error while rendering this screen. Your
            data is safe — reload to get back to work.
          </p>

          <div className="mt-6 flex w-full items-start gap-3 rounded-2xl border border-border/60 bg-card p-4 text-start">
            <Bug className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {this.state.error.name}
              </p>
              <p className="mt-1 line-clamp-3 break-words font-mono text-[11px] text-muted-foreground/80">
                {this.state.error.message || "Unknown error"}
              </p>
              <p className="mt-2 text-[10px] text-muted-foreground/50">
                event {this.state.eventId}
              </p>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-2">
            <Button onClick={this.reload}>
              <RefreshCw className="size-4" /> Reload
            </Button>
            <Button variant="outline" onClick={() => { window.location.href = "/overview"; }}>
              <Home className="size-4" /> Go to Overview
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

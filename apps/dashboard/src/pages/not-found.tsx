import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl font-semibold tracking-tight text-muted-foreground/30">404</p>
      <h1 className="mt-3 text-lg font-semibold">Page not found</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">The resource you're looking for doesn't exist or was removed.</p>
      <Button asChild className="mt-6">
        <Link to="/overview">Back to overview</Link>
      </Button>
    </div>
  );
}

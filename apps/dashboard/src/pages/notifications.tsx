import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { get, post } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/components/toast";
import type { Notification } from "@nexus/types";

export function NotificationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["notifications"], queryFn: () => get<{ items: Notification[]; unread: number }>("/notifications", { limit: "50" }), refetchInterval: 15000 });

  const markRead = async (id: string) => {
    await post(`/notifications/${id}/read`);
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markAll = async () => {
    await post("/notifications/read-all");
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    toast("success", "All notifications marked as read");
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Notifications"
        description="Deployment results, server status changes and infrastructure events."
        actions={
          data && data.unread > 0 ? (
            <Button variant="outline" onClick={markAll}>
              <BellOff className="size-4" /> Mark all read
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <TableSkeleton rows={8} cols={3} />
      ) : !data?.items.length ? (
        <EmptyState icon={<Bell className="size-5" />} title="No notifications" description="You're all caught up." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((n) => (
              <button
                key={n.id}
                onClick={() => !n.read && markRead(n.id)}
                className={`flex w-full items-start gap-3 px-5 py-3.5 text-start transition-colors hover:bg-foreground/[0.05] ${n.read ? "opacity-60" : ""}`}
              >
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read ? "bg-zinc-300 dark:bg-zinc-700" : "bg-primary"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{n.message}</p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

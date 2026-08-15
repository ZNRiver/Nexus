import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/layout";
import { SetupPage } from "@/pages/setup";
import { LoginPage } from "@/pages/login";
import { OverviewPage } from "@/pages/overview";
import { ServersPage } from "@/pages/servers";
import { ServerDetailPage } from "@/pages/server-detail";
import { ProjectsPage } from "@/pages/projects";
import { ApplicationsPage } from "@/pages/applications";
import { NewApplicationPage } from "@/pages/new-application";
import { ApplicationDetailPage } from "@/pages/application-detail";
import { DeploymentsPage } from "@/pages/deployments";
import { DatabasesPage } from "@/pages/databases";
import { DatabaseDetailPage } from "@/pages/database-detail";
import { ContainersPage } from "@/pages/containers";
import { ImagesPage } from "@/pages/images";
import { VolumesPage } from "@/pages/volumes";
import { NetworksPage } from "@/pages/networks";
import { DomainsPage } from "@/pages/domains";
import { MonitoringPage } from "@/pages/monitoring";
import { GameServersPage } from "@/pages/game-servers";
import { GameServerDetailPage } from "@/pages/game-server-detail";
import { BackupsPage } from "@/pages/backups";
import { JobsPage } from "@/pages/jobs";
import { AuditPage } from "@/pages/audit";
import { NotificationsPage } from "@/pages/notifications";
import { SettingsPage } from "@/pages/settings";
import { NotFoundPage } from "@/pages/not-found";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/servers/:id" element={<ServerDetailPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/new" element={<NewApplicationPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/deployments" element={<DeploymentsPage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/databases/new" element={<DatabasesPage mode="new" />} />
          <Route path="/databases/:id" element={<DatabaseDetailPage />} />
          <Route path="/containers" element={<ContainersPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/volumes" element={<VolumesPage />} />
          <Route path="/networks" element={<NetworksPage />} />
          <Route path="/domains" element={<DomainsPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/game-servers" element={<GameServersPage />} />
          <Route path="/game-servers/new" element={<GameServersPage mode="new" />} />
          <Route path="/game-servers/:id" element={<GameServerDetailPage />} />
          <Route path="/backups" element={<BackupsPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

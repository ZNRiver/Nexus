import type { Role } from "@nexus/types";

export type Permission =
  | "server.read"
  | "server.write"
  | "server.delete"
  | "application.read"
  | "application.write"
  | "application.deploy"
  | "application.delete"
  | "database.read"
  | "database.write"
  | "database.delete"
  | "deployment.read"
  | "deployment.create"
  | "deployment.cancel"
  | "deployment.rollback"
  | "infra.read"
  | "infra.write"
  | "infra.delete"
  | "backup.create"
  | "backup.restore"
  | "backup.delete"
  | "settings.read"
  | "settings.write"
  | "audit.read"
  | "project.write"
  | "project.delete"
  | "game.read"
  | "game.write"
  | "game.delete"
  | "notification.read"
  | "notification.write";

const READ_ALL: Permission[] = [
  "server.read",
  "application.read",
  "database.read",
  "deployment.read",
  "infra.read",
  "settings.read",
  "audit.read",
  "game.read",
  "notification.read",
];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...READ_ALL, "server.write", "server.delete", "application.write", "application.deploy", "application.delete", "database.write", "database.delete", "deployment.create", "deployment.cancel", "deployment.rollback", "infra.write", "infra.delete", "backup.create", "backup.restore", "backup.delete", "settings.write", "project.write", "project.delete", "game.write", "game.delete", "notification.write"],
  admin: [...READ_ALL, "server.write", "application.write", "application.deploy", "application.delete", "database.write", "database.delete", "deployment.create", "deployment.cancel", "deployment.rollback", "infra.write", "infra.delete", "backup.create", "backup.restore", "backup.delete", "project.write", "project.delete", "game.write", "game.delete", "notification.write"],
  developer: [...READ_ALL, "application.write", "application.deploy", "database.write", "deployment.create", "deployment.cancel", "deployment.rollback", "infra.write", "backup.create", "backup.restore", "project.write", "game.write", "notification.write"],
  viewer: [...READ_ALL],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export const ROLE_ORDER: Role[] = ["owner", "admin", "developer", "viewer"];

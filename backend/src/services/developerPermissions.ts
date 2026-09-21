/**
 * Developer Platform — role/permission model (Phase 11).
 *
 * Roles are resolved SERVER-SIDE from developer_members + developer_roles.
 * A client-supplied role is never trusted. OWNER is only granted by the admin
 * approval flow; invitations and role changes can never assign it.
 */

export type DeveloperRole =
  | 'OWNER'
  | 'ADMIN'
  | 'DEVELOPER'
  | 'RELEASE_MANAGER'
  | 'ANALYST'
  | 'SUPPORT';

export const DEVELOPER_ROLES: DeveloperRole[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'RELEASE_MANAGER', 'ANALYST', 'SUPPORT'];

/** Roles that can be granted by team management (never OWNER). */
export const ASSIGNABLE_ROLES: DeveloperRole[] = ['ADMIN', 'DEVELOPER', 'RELEASE_MANAGER', 'ANALYST', 'SUPPORT'];

/**
 * Canonical permission matrix (mirrors the seeded developer_roles table).
 * Keep both in sync — the table is the runtime source, this is the typed
 * reference used by tests and the UI.
 */
export const ROLE_PERMISSIONS: Record<DeveloperRole, string[]> = {
  OWNER: [
    'organization.manage', 'team.manage', 'app.create', 'app.edit',
    'release.create', 'release.edit', 'package.upload', 'release.submit',
    'release.publish', 'analytics.view', 'reviews.manage', 'support.respond',
    'billing.manage', 'security.view',
  ],
  ADMIN: [
    'organization.manage', 'team.manage', 'app.create', 'app.edit',
    'release.create', 'release.edit', 'package.upload', 'release.submit',
    'release.publish', 'analytics.view', 'reviews.manage', 'support.respond',
    'security.view',
  ],
  DEVELOPER: ['app.create', 'app.edit', 'release.create', 'release.edit', 'package.upload', 'analytics.view'],
  RELEASE_MANAGER: ['app.edit', 'release.create', 'release.edit', 'package.upload', 'release.submit', 'release.publish', 'analytics.view'],
  ANALYST: ['analytics.view', 'reviews.manage'],
  SUPPORT: ['reviews.manage', 'support.respond'],
};

export function isDeveloperRole(v: unknown): v is DeveloperRole {
  return typeof v === 'string' && (DEVELOPER_ROLES as string[]).includes(v);
}

export function isAssignableRole(v: unknown): v is DeveloperRole {
  return typeof v === 'string' && (ASSIGNABLE_ROLES as string[]).includes(v);
}

/** Does `role` carry `permission`? Pure — unit-testable. */
export function hasPermission(role: DeveloperRole, permission: string): boolean {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

/** Permissions for a role as a sorted copy (safe to return to clients). */
export function permissionsForRole(role: DeveloperRole): string[] {
  return [...(ROLE_PERMISSIONS[role] || [])].sort();
}

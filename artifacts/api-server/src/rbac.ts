export type Role = 'Lead' | 'Contributor' | 'Viewer';

export const ROLE_RANK: Record<Role, number> = {
  Lead: 3,
  Contributor: 2,
  Viewer: 1,
};

export function canEditNode(userRole: Role, lockedToRole: Role | null | undefined): boolean {
  if (userRole === 'Viewer') return false;
  if (!lockedToRole) return true;
  return ROLE_RANK[userRole] >= ROLE_RANK[lockedToRole];
}

export function canCreateNode(userRole: Role): boolean {
  return userRole !== 'Viewer';
}

export function canDeleteNode(userRole: Role, lockedToRole: Role | null | undefined): boolean {
  return canEditNode(userRole, lockedToRole);
}

export function canChangeLock(userRole: Role): boolean {
  return userRole === 'Lead';
}

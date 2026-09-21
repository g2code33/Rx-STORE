/**
 * Developer Platform routes (Phase 11).
 *
 * Two route objects, both dispatched inline from backend/src/index.ts (the
 * generic router does not dispatch mounted objects):
 *   - developerRoutes        authenticated, membership/permission enforced
 *   - adminDeveloperRoutes   admin-gated by index.ts (/admin/* requires an
 *                            admin JWT before any handler runs)
 *
 * Security model:
 *   - Organization is ALWAYS resolved from the caller's own membership
 *     (developer_members). No org id is accepted from the client, so a user
 *     can never address another organization.
 *   - Roles/permissions come from developer_members + the seeded matrix —
 *     a client-supplied role is never trusted.
 *   - OWNER can only be granted by the admin approval flow. Invitations and
 *     role changes accept assignable roles only, and the final OWNER cannot
 *     be removed or demoted.
 *   - Every important action writes developer_audit_logs (and admin actions
 *     also write the existing global audit_logs).
 */

import { hashToken } from '../services/sessions.ts';
import { validateEmail } from '../utils/validation.ts';
import {
  isAssignableRole, hasPermission, permissionsForRole,
} from '../services/developerPermissions.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OK_STATUSES = ['ACTIVE'] as const;

function userIdOf(request: Request): string | null {
  return ((request as any).user as any)?.userId || null;
}

async function bodyOf(request: Request): Promise<any> {
  return await request.json().catch(() => ({}));
}

/** Prefixed unique id, existing project convention (app_…, n_…, log_…). */
export function rid(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** A stable, short, public developer id: dev_xxxxxxxxx */
function newDeveloperId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `dev_${s}`;
}

/** High-entropy invitation token (raw is shown ONCE to the inviter, never stored). */
function newInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function auditDev(env: any, developerId: string, actorUserId: string | null, action: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO developer_audit_logs (id, developer_id, actor_user_id, action, details) VALUES (?,?,?,?,?)')
    .bind(rid('dl'), developerId, actorUserId, action, JSON.stringify(details)).run().catch(() => {});
}

/** Global audit event (existing audit_logs table) for admin-side actions. */
async function auditGlobal(env: any, action: string, resourceId: string, details: Record<string, unknown> = {}) {
  await env.DB.prepare('INSERT INTO audit_logs (id, action, resource_type, resource_id, details) VALUES (?,?,?,?,?)')
    .bind(rid('log'), action, 'developer', resourceId, JSON.stringify(details)).run().catch(() => {});
}

export async function notify(env: any, userId: string, type: 'update' | 'message' | 'system', title: string, message: string, data: Record<string, unknown> = {}) {
  if (!userId) return;
  await env.DB.prepare('INSERT INTO notifications (id, user_id, type, title, message, data, read) VALUES (?,?,?,?,?,?,0)')
    .bind(rid('n'), userId, type, title, message, JSON.stringify(data)).run().catch(() => {});
}

export async function notifyAdmins(env: any, title: string, message: string, data: Record<string, unknown> = {}) {
  const rows: any = await env.DB.prepare("SELECT id FROM users WHERE role='admin'").all().catch(() => ({ results: [] }));
  for (const r of rows?.results || []) await notify(env, r.id, 'message', title, message, data);
}

/** Resolve the caller's developer organization from their OWN membership. */
export async function resolveMembership(env: any, userId: string): Promise<{ member: any; developer: any } | null> {
  const row: any = await env.DB.prepare(
    `SELECT m.id AS member_id, m.role, m.created_at AS member_since, d.*
     FROM developer_members m JOIN developers d ON d.id = m.developer_id
     WHERE m.user_id = ?`
  ).bind(userId).first().catch(() => null);
  if (!row) return null;
  return {
    member: { id: row.member_id, role: row.role, since: row.member_since },
    developer: row,
  };
}

/** Resolve membership AND require a permission. Returns an error object on failure. */
export async function requirePermission(env: any, userId: string, permission: string) {
  const ms = await resolveMembership(env, userId);
  if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' as const };
  if (!hasPermission(ms.member.role, permission)) {
    return { error: `Your role (${ms.member.role}) does not allow this action`, code: 'FORBIDDEN' as const };
  }
  return { ms };
}

export function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

export function isHttpUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

/** Validate + normalize the application form. `forSubmit` demands completeness. */
function validateApplication(body: any, forSubmit: boolean): { errors: string[]; fields: Record<string, any> } {
  const errors: string[] = [];
  const fields: Record<string, any> = {};

  const publisherName = str(body.publisher_name ?? body.publisherName, 100);
  if (forSubmit && publisherName.length < 2) errors.push('Publisher/developer name is required (2+ characters)');
  if (publisherName) fields.publisher_name = publisherName;

  const type = str(body.developer_type ?? body.developerType, 20).toLowerCase();
  if (type && !['individual', 'organization'].includes(type)) errors.push('Developer type must be individual or organization');
  if (forSubmit && !type) errors.push('Choose whether you are an individual or an organization');
  if (type) fields.developer_type = type;

  const contactEmail = str(body.contact_email ?? body.contactEmail, 200).toLowerCase();
  if (contactEmail && !validateEmail(contactEmail)) errors.push('Contact email is not a valid email address');
  if (forSubmit && !contactEmail) errors.push('Contact email is required');
  if (contactEmail) fields.contact_email = contactEmail;

  const supportEmail = str(body.support_email ?? body.supportEmail, 200).toLowerCase();
  if (supportEmail && !validateEmail(supportEmail)) errors.push('Support email is not a valid email address');
  if (forSubmit && !supportEmail) errors.push('Support email is required');
  if (supportEmail) fields.support_email = supportEmail;

  const website = str(body.website, 300);
  if (website && !isHttpUrl(website)) errors.push('Website must be a valid http(s) URL');
  if (website) fields.website = website;

  const country = str(body.country ?? body.region, 80);
  if (forSubmit && !country) errors.push('Country/region is required');
  if (country) fields.country = country;

  const description = str(body.description, 2000);
  if (forSubmit && description.length < 20) errors.push('Description is required (20+ characters)');
  if (description) fields.description = description;

  const category = str(body.category, 60);
  if (category) fields.category = category;

  const terms = body.accepted_terms === true || body.acceptedTerms === true;
  if (forSubmit && !terms) errors.push('You must accept the developer terms to submit');
  if (terms) { fields.accepted_terms = 1; fields.terms_accepted_at = new Date().toISOString(); }

  return { errors, fields };
}

// ---------------------------------------------------------------------------
// Developer-side routes (authenticated; user attached by index.ts)
// ---------------------------------------------------------------------------

export const developerRoutes = {

  /**
   * GET /developers/public/:id — PUBLIC developer profile.
   * Only developer_profiles + published apps are exposed. Private application
   * data (contact/verification), members and audit are NEVER returned here.
   */
  async publicProfile(developerId: string, env: any) {
    const id = String(developerId || '').trim();
    if (!/^dev_[a-z2-9]+$/.test(id)) return { error: 'Developer not found', code: 'NOT_FOUND' };
    const dev: any = await env.DB.prepare(
      `SELECT d.id, d.status, d.created_at, p.publisher_name, p.logo, p.description, p.website, p.support_url
       FROM developers d LEFT JOIN developer_profiles p ON p.developer_id=d.id
       WHERE d.id=? AND d.status='ACTIVE'`
    ).bind(id).first().catch(() => null);
    if (!dev) return { error: 'Developer not found', code: 'NOT_FOUND' };
    const apps: any = await env.DB.prepare(
      `SELECT slug, name, description, icon, current_version, rating, review_count, download_count, platforms
       FROM applications WHERE developer_org_id=? AND status='active' ORDER BY download_count DESC`
    ).bind(id).all().catch(() => ({ results: [] }));
    return {
      developer: {
        id: dev.id,
        publisherName: dev.publisher_name,
        logo: dev.logo,
        description: dev.description,
        website: dev.website,
        supportUrl: dev.support_url,
        developerSince: dev.created_at,
      },
      apps: apps?.results || [],
    };
  },

  /** GET /developers/me — one call answers "who am I" for routing the UI. */
  async getStatus(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };

    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE user_id=?').bind(userId).first().catch(() => null);
    const ms = await resolveMembership(env, userId);

    return {
      status: ms ? (ms.developer.status === 'SUSPENDED' ? 'SUSPENDED' : 'APPROVED')
        : app ? app.status : 'NOT_APPLIED',
      application: app ? {
        id: app.id, status: app.status, publisherName: app.publisher_name,
        developerType: app.developer_type, contactEmail: app.contact_email,
        supportEmail: app.support_email, website: app.website, country: app.country,
        description: app.description, category: app.category,
        acceptedTerms: !!app.accepted_terms, submittedAt: app.submitted_at,
        reviewedAt: app.reviewed_at, reviewReason: app.review_reason,
        createdAt: app.created_at,
      } : null,
      developer: ms ? {
        id: ms.developer.id, status: ms.developer.status,
        role: ms.member.role, permissions: permissionsForRole(ms.member.role),
        publisherName: null, // filled by the organization endpoint (profile join)
      } : null,
    };
  },

  /** POST /developers/apply — create or update a DRAFT application. */
  async saveApplication(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const body = await bodyOf(request);

    const existing: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE user_id=?').bind(userId).first().catch(() => null);
    if (existing && !['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(existing.status)) {
      return { error: `Your application is ${existing.status} and cannot be edited`, code: 'FORBIDDEN' };
    }

    const { errors, fields } = validateApplication(body, false);
    if (errors.length) return { error: errors[0], code: 'VALIDATION_ERROR', errors };

    if (existing) {
      const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
      if (sets) {
        await env.DB.prepare(`UPDATE developer_applications SET ${sets}, updated_at=datetime('now') WHERE id=?`)
          .bind(...Object.values(fields), existing.id).run();
      }
      return { application: { id: existing.id, status: existing.status }, saved: true };
    }

    const id = rid('da');
    await env.DB.prepare(
      `INSERT INTO developer_applications (id, user_id, status, publisher_name, developer_type, contact_email, support_email, website, country, description, category, accepted_terms, terms_accepted_at)
       VALUES (?,?, 'DRAFT', ?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, userId, fields.publisher_name ?? null, fields.developer_type ?? null, fields.contact_email ?? null,
      fields.support_email ?? null, fields.website ?? null, fields.country ?? null, fields.description ?? null,
      fields.category ?? null, fields.accepted_terms ?? 0, fields.terms_accepted_at ?? null).run();
    await auditGlobal(env, 'developer_application_created', id, { userId });
    return { application: { id, status: 'DRAFT' }, saved: true };
  },

  /** POST /developers/application/submit — DRAFT/CHANGES_REQUESTED/REJECTED -> SUBMITTED. */
  async submitApplication(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };

    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE user_id=?').bind(userId).first().catch(() => null);
    if (!app) return { error: 'No application found — start one first', code: 'NOT_FOUND' };
    if (!['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(app.status)) {
      return { error: `Only draft, changes-requested or rejected applications can be submitted (current: ${app.status})`, code: 'FORBIDDEN' };
    }

    // Validate the FULL record (stored fields + anything in this request).
    const body = await bodyOf(request).catch(() => ({}));
    const merged = {
      publisher_name: body.publisher_name ?? app.publisher_name,
      developer_type: body.developer_type ?? app.developer_type,
      contact_email: body.contact_email ?? app.contact_email,
      support_email: body.support_email ?? app.support_email,
      website: body.website ?? app.website,
      country: body.country ?? app.country,
      description: body.description ?? app.description,
      category: body.category ?? app.category,
      accepted_terms: body.accepted_terms ?? !!app.accepted_terms,
    };
    const { errors } = validateApplication(merged, true);
    if (errors.length) return { error: errors[0], code: 'VALIDATION_ERROR', errors };

    await env.DB.prepare(
      `UPDATE developer_applications SET status='SUBMITTED', submitted_at=datetime('now'), updated_at=datetime('now'),
       accepted_terms=1, terms_accepted_at=COALESCE(terms_accepted_at, datetime('now')), review_reason=NULL WHERE id=?`
    ).bind(app.id).run();
    await auditGlobal(env, 'developer_application_submitted', app.id, { userId });
    await notifyAdmins(env, 'Developer application submitted', 'A new developer application is waiting for review.', { link: '/admin' });
    return { application: { id: app.id, status: 'SUBMITTED' } };
  },

  /** GET /developers/organization — the org + real marketplace data for the center. */
  async getOrganization(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };

    const profile: any = await env.DB.prepare('SELECT * FROM developer_profiles WHERE developer_id=?').bind(ms.developer.id).first().catch(() => null);
    const apps: any = await env.DB.prepare(
      'SELECT id, slug, name, description, status, current_version, download_count, rating, review_count, icon, platforms FROM applications WHERE developer_org_id=? ORDER BY created_at DESC'
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    const releases: any = await env.DB.prepare(
      `SELECT r.id, r.version, r.channel, r.status, r.published_at, r.created_at, a.slug AS app_slug, a.name AS app_name
       FROM releases r JOIN applications a ON a.id = r.application_id
       WHERE a.developer_org_id=? ORDER BY r.created_at DESC LIMIT 20`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    const reviews: any = await env.DB.prepare(
      `SELECT rv.id, rv.rating, rv.comment, rv.created_at, a.slug AS app_slug, a.name AS app_name
       FROM reviews rv JOIN applications a ON a.id = rv.app_id
       WHERE a.developer_org_id=? ORDER BY rv.created_at DESC LIMIT 10`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));

    const appRows = apps?.results || [];
    const stats = {
      apps: appRows.length,
      published: appRows.filter((a: any) => a.status === 'active').length,
      downloads: appRows.reduce((s: number, a: any) => s + (Number(a.download_count) || 0), 0),
      reviews: appRows.reduce((s: number, a: any) => s + (Number(a.review_count) || 0), 0),
      avgRating: appRows.length ? Number((appRows.reduce((s: number, a: any) => s + (Number(a.rating) || 0), 0) / appRows.length).toFixed(2)) : 0,
    };

    return {
      organization: {
        id: ms.developer.id,
        status: ms.developer.status,
        developerSince: ms.developer.created_at,
        myRole: ms.member.role,
        permissions: permissionsForRole(ms.member.role),
        profile: profile ? {
          publisherName: profile.publisher_name, logo: profile.logo, description: profile.description,
          website: profile.website, supportUrl: profile.support_url,
        } : null,
      },
      apps: appRows,
      releases: releases?.results || [],
      reviews: reviews?.results || [],
      stats,
    };
  },

  /** PATCH /developers/profile — public profile (organization.manage). */
  async updateProfile(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'organization.manage');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;
    if (!OK_STATUSES.includes(ms.developer.status)) return { error: 'This organization is suspended', code: 'FORBIDDEN' };

    const body = await bodyOf(request);
    const fields: Record<string, any> = {};
    if (body.publisher_name !== undefined) {
      const v = str(body.publisher_name, 100);
      if (v.length < 2) return { error: 'Publisher name must be at least 2 characters', code: 'VALIDATION_ERROR' };
      fields.publisher_name = v;
    }
    if (body.logo !== undefined) { const v = str(body.logo, 500); if (v && !isHttpUrl(v)) return { error: 'Logo must be a URL', code: 'VALIDATION_ERROR' }; fields.logo = v || null; }
    if (body.description !== undefined) fields.description = str(body.description, 1000);
    if (body.website !== undefined) { const v = str(body.website, 300); if (v && !isHttpUrl(v)) return { error: 'Website must be a URL', code: 'VALIDATION_ERROR' }; fields.website = v || null; }
    if (body.support_url !== undefined) { const v = str(body.support_url, 300); if (v && !isHttpUrl(v)) return { error: 'Support URL must be a URL', code: 'VALIDATION_ERROR' }; fields.support_url = v || null; }
    if (!Object.keys(fields).length) return { error: 'Nothing to update', code: 'VALIDATION_ERROR' };

    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE developer_profiles SET ${sets}, updated_at=datetime('now') WHERE developer_id=?`)
      .bind(...Object.values(fields), ms.developer.id).run();
    await auditDev(env, ms.developer.id, userId, 'developer_profile_updated', fields);
    return { success: true };
  },

  /** GET /developers/team — members + pending invitations (any member can view). */
  async getTeam(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };

    const members: any = await env.DB.prepare(
      `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.name, u.email
       FROM developer_members m JOIN users u ON u.id = m.user_id
       WHERE m.developer_id=? ORDER BY m.created_at ASC`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    const invitations: any = await env.DB.prepare(
      `SELECT id, email, role, status, expires_at, created_at FROM developer_invitations
       WHERE developer_id=? AND status='PENDING' ORDER BY created_at DESC`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));

    return {
      role: ms.member.role,
      permissions: permissionsForRole(ms.member.role),
      members: (members?.results || []).map((m: any) => ({ id: m.id, userId: m.user_id, name: m.name, email: m.email, role: m.role, since: m.created_at })),
      invitations: invitations?.results || [],
    };
  },

  /** POST /developers/team/invite — creates a hashed, expiring invitation. */
  async inviteMember(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'team.manage');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;
    if (!OK_STATUSES.includes(ms.developer.status)) return { error: 'This organization is suspended', code: 'FORBIDDEN' };

    const body = await bodyOf(request);
    const email = str(body.email, 200).toLowerCase();
    const role = String(body.role || 'DEVELOPER').toUpperCase();
    if (!validateEmail(email)) return { error: 'A valid email address is required', code: 'VALIDATION_ERROR' };
    if (!isAssignableRole(role)) return { error: `Role must be one of: ADMIN, DEVELOPER, RELEASE_MANAGER, ANALYST, SUPPORT`, code: 'VALIDATION_ERROR' };

    // Duplicate protection: existing member, pending invite, or the owner themself.
    const existingMember: any = await env.DB.prepare(
      `SELECT m.id FROM developer_members m JOIN users u ON u.id=m.user_id WHERE m.developer_id=? AND LOWER(u.email)=?`
    ).bind(ms.developer.id, email).first().catch(() => null);
    if (existingMember) return { error: 'That person is already a member of this organization', code: 'VALIDATION_ERROR' };
    const pending: any = await env.DB.prepare(
      `SELECT id FROM developer_invitations WHERE developer_id=? AND LOWER(email)=? AND status='PENDING'`
    ).bind(ms.developer.id, email).first().catch(() => null);
    if (pending) return { error: 'An invitation for that email is already pending', code: 'VALIDATION_ERROR' };

    // Bound the number of pending invitations.
    const count: any = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM developer_invitations WHERE developer_id=? AND status='PENDING'`
    ).bind(ms.developer.id).first().catch(() => ({ c: 0 }));
    if (Number(count?.c || 0) >= 50) return { error: 'Too many pending invitations — cancel some first', code: 'VALIDATION_ERROR' };

    const token = newInviteToken();
    const tokenHash = await hashToken(token);
    const id = rid('di');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO developer_invitations (id, developer_id, email, role, token_hash, status, invited_by, expires_at) VALUES (?,?,?,?,?,'PENDING',?,?)`
    ).bind(id, ms.developer.id, email, role, tokenHash, userId, expires).run();
    await auditDev(env, ms.developer.id, userId, 'developer_member_invited', { email, role });

    // The RAW token is returned exactly ONCE for the inviter to share. Only its
    // hash is stored. (Email delivery of invitations is not automated yet — the
    // inviter copies the link.)
    return { invitation: { id, email, role, expiresAt: expires }, inviteToken: token };
  },

  /** POST /developers/team/invitations/:id/cancel */
  async cancelInvitation(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'team.manage');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;
    const invId = new URL(request.url).pathname.split('/')[4] || '';
    const inv: any = await env.DB.prepare('SELECT * FROM developer_invitations WHERE id=? AND developer_id=?')
      .bind(invId, ms.developer.id).first().catch(() => null);
    if (!inv) return { error: 'Invitation not found', code: 'NOT_FOUND' };
    if (inv.status !== 'PENDING') return { error: `Invitation is already ${String(inv.status).toLowerCase()}`, code: 'VALIDATION_ERROR' };
    await env.DB.prepare(`UPDATE developer_invitations SET status='CANCELLED' WHERE id=?`).bind(invId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_member_invitation_cancelled', { invitationId: invId, email: inv.email });
    return { success: true };
  },

  /** POST /developers/invitations/accept — token + matching account email. */
  async acceptInvitation(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const token = String((await bodyOf(request)).token || '').trim();
    if (!token) return { error: 'Invitation token required', code: 'VALIDATION_ERROR' };

    const tokenHash = await hashToken(token);
    const inv: any = await env.DB.prepare('SELECT * FROM developer_invitations WHERE token_hash=?').bind(tokenHash).first().catch(() => null);
    if (!inv || inv.status !== 'PENDING') return { error: 'This invitation is no longer valid', code: 'NOT_FOUND' };
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      await env.DB.prepare(`UPDATE developer_invitations SET status='EXPIRED' WHERE id=?`).bind(inv.id).run().catch(() => {});
      return { error: 'This invitation has expired', code: 'NOT_FOUND' };
    }
    const user: any = await env.DB.prepare('SELECT id, email FROM users WHERE id=?').bind(userId).first().catch(() => null);
    if (!user || String(user.email || '').toLowerCase() !== String(inv.email).toLowerCase()) {
      return { error: 'This invitation was issued to a different email address — sign in with that account', code: 'FORBIDDEN' };
    }
    const already: any = await env.DB.prepare('SELECT id FROM developer_members WHERE developer_id=? AND user_id=?')
      .bind(inv.developer_id, userId).first().catch(() => null);
    if (already) {
      await env.DB.prepare(`UPDATE developer_invitations SET status='ACCEPTED', accepted_at=datetime('now') WHERE id=?`).bind(inv.id).run().catch(() => {});
      return { error: 'You are already a member of this organization', code: 'VALIDATION_ERROR' };
    }

    await env.DB.prepare('INSERT INTO developer_members (id, developer_id, user_id, role) VALUES (?,?,?,?)')
      .bind(rid('dm'), inv.developer_id, userId, inv.role).run();
    await env.DB.prepare(`UPDATE developer_invitations SET status='ACCEPTED', accepted_at=datetime('now') WHERE id=?`).bind(inv.id).run();
    await auditDev(env, inv.developer_id, userId, 'developer_member_accepted', { email: inv.email, role: inv.role });
    return { success: true, developerId: inv.developer_id, role: inv.role };
  },

  /** PATCH /developers/team/role — change a member's role (audited, protected). */
  async changeRole(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'team.manage');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;
    if (!OK_STATUSES.includes(ms.developer.status)) return { error: 'This organization is suspended', code: 'FORBIDDEN' };

    const body = await bodyOf(request);
    const targetUserId = str(body.userId, 60);
    const role = String(body.role || '').toUpperCase();
    if (!targetUserId) return { error: 'userId is required', code: 'VALIDATION_ERROR' };
    if (!isAssignableRole(role)) return { error: 'Roles are assigned from: ADMIN, DEVELOPER, RELEASE_MANAGER, ANALYST, SUPPORT', code: 'VALIDATION_ERROR' };

    const target: any = await env.DB.prepare('SELECT * FROM developer_members WHERE developer_id=? AND user_id=?')
      .bind(ms.developer.id, targetUserId).first().catch(() => null);
    if (!target) return { error: 'That user is not a member of your organization', code: 'NOT_FOUND' };
    if (target.role === role) return { error: 'That member already has this role', code: 'VALIDATION_ERROR' };
    if (target.role === 'OWNER') {
      // Only an OWNER may touch an OWNER, and never the final one.
      if (ms.member.role !== 'OWNER') return { error: 'Only the owner can change the owner role', code: 'FORBIDDEN' };
      const owners: any = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM developer_members WHERE developer_id=? AND role='OWNER'`
      ).bind(ms.developer.id).first().catch(() => ({ c: 1 }));
      if (Number(owners?.c || 0) <= 1) return { error: 'The final owner cannot be demoted — transfer ownership first', code: 'FORBIDDEN' };
    }

    await env.DB.prepare('UPDATE developer_members SET role=?, updated_at=datetime(\'now\') WHERE id=?').bind(role, target.id).run();
    await auditDev(env, ms.developer.id, userId, 'developer_role_changed', { targetUserId, from: target.role, to: role });
    await notify(env, targetUserId, 'system', 'Your developer role changed', `Your role is now ${role}.`, {});
    return { success: true };
  },

  /** DELETE /developers/team/:userId — remove a member (final owner protected). */
  async removeMember(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'team.manage');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;

    const targetUserId = decodeURIComponent(new URL(request.url).pathname.split('/')[3] || '');
    if (!targetUserId) return { error: 'Member not found', code: 'NOT_FOUND' };
    const target: any = await env.DB.prepare('SELECT * FROM developer_members WHERE developer_id=? AND user_id=?')
      .bind(ms.developer.id, targetUserId).first().catch(() => null);
    if (!target) return { error: 'That user is not a member of your organization', code: 'NOT_FOUND' };

    if (target.role === 'OWNER') {
      if (ms.member.role !== 'OWNER') return { error: 'Only the owner can remove the owner', code: 'FORBIDDEN' };
      const owners: any = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM developer_members WHERE developer_id=? AND role='OWNER'`
      ).bind(ms.developer.id).first().catch(() => ({ c: 1 }));
      if (Number(owners?.c || 0) <= 1) return { error: 'The final owner cannot be removed', code: 'FORBIDDEN' };
    }

    await env.DB.prepare('DELETE FROM developer_members WHERE id=?').bind(target.id).run();
    await auditDev(env, ms.developer.id, userId, 'developer_member_removed', { targetUserId, role: target.role });
    await notify(env, targetUserId, 'system', 'Removed from developer organization', 'You were removed from the developer team.', {});
    return { success: true };
  },

  /** GET /developers/audit — org audit history (security.view). */
  async listAudit(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const guard = await requirePermission(env, userId, 'security.view');
    if ('error' in guard && guard.error) return guard;
    const ms = (guard as any).ms;
    const rows: any = await env.DB.prepare(
      'SELECT id, action, actor_user_id, details, created_at FROM developer_audit_logs WHERE developer_id=? ORDER BY created_at DESC LIMIT 100'
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    return { events: rows?.results || [] };
  },

  /** GET /developers/communications — own org threads. */
  async listThreads(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const rows: any = await env.DB.prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM developer_thread_messages m WHERE m.thread_id=t.id AND m.sender_context='ADMIN' AND m.read_by_developer_at IS NULL) AS unread
       FROM developer_threads t WHERE t.developer_id=? ORDER BY t.updated_at DESC LIMIT 50`
    ).bind(ms.developer.id).all().catch(() => ({ results: [] }));
    return { threads: rows?.results || [] };
  },

  /** POST /developers/communications/threads — open a thread with RX Store. */
  async createThread(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const body = await bodyOf(request);
    const subject = str(body.subject, 150);
    const message = str(body.message ?? body.body, 5000);
    if (subject.length < 3) return { error: 'Subject is required (3+ characters)', code: 'VALIDATION_ERROR' };
    if (!message) return { error: 'Message is required', code: 'VALIDATION_ERROR' };

    const threadId = rid('dt');
    await env.DB.prepare(
      `INSERT INTO developer_threads (id, developer_id, subject, related_application_id, related_app_id, related_release_id, status, action_required)
       VALUES (?,?,?,?,?,?, 'AWAITING_ADMIN', 1)`
    ).bind(threadId, ms.developer.id, subject,
      str(body.relatedApplicationId, 60) || null, str(body.relatedAppId, 60) || null, str(body.relatedReleaseId, 60) || null).run();
    await env.DB.prepare(
      `INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body, attachments) VALUES (?,?,?, 'DEVELOPER', ?,?)`
    ).bind(rid('dmsg'), threadId, userId, message, JSON.stringify(Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [])).run();
    await auditDev(env, ms.developer.id, userId, 'developer_admin_message_sent', { threadId, subject });
    await notifyAdmins(env, `Developer message: ${subject}`, 'A developer opened a communication thread.', { threadId });
    return { thread: { id: threadId, subject, status: 'AWAITING_ADMIN' } };
  },

  /** GET /developers/communications/:threadId — messages (marks admin msgs read). */
  async getThread(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const threadId = new URL(request.url).pathname.split('/')[3] || '';
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=? AND developer_id=?')
      .bind(threadId, ms.developer.id).first().catch(() => null);
    if (!thread) return { error: 'Thread not found', code: 'NOT_FOUND' };
    const messages: any = await env.DB.prepare(
      'SELECT id, sender_user_id, sender_context, body, attachments, read_by_developer_at, read_by_admin_at, created_at FROM developer_thread_messages WHERE thread_id=? ORDER BY created_at ASC'
    ).bind(threadId).all().catch(() => ({ results: [] }));
    await env.DB.prepare(
      `UPDATE developer_thread_messages SET read_by_developer_at=datetime('now') WHERE thread_id=? AND sender_context='ADMIN' AND read_by_developer_at IS NULL`
    ).bind(threadId).run().catch(() => {});
    return { thread, messages: messages?.results || [] };
  },

  /** POST /developers/communications/:threadId/messages */
  async sendMessage(request: Request, env: any) {
    const userId = userIdOf(request);
    if (!userId) return { error: 'Authentication required', code: 'UNAUTHORIZED' };
    const ms = await resolveMembership(env, userId);
    if (!ms) return { error: 'No developer organization for this account', code: 'FORBIDDEN' };
    const threadId = new URL(request.url).pathname.split('/')[3] || '';
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=? AND developer_id=?')
      .bind(threadId, ms.developer.id).first().catch(() => null);
    if (!thread) return { error: 'Thread not found', code: 'NOT_FOUND' };
    if (thread.status === 'CLOSED') return { error: 'This thread is closed', code: 'FORBIDDEN' };
    const message = str((await bodyOf(request)).message, 5000);
    if (!message) return { error: 'Message is required', code: 'VALIDATION_ERROR' };

    await env.DB.prepare(
      `INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?, 'DEVELOPER', ?)`
    ).bind(rid('dmsg'), threadId, userId, message).run();
    await env.DB.prepare(`UPDATE developer_threads SET status='AWAITING_ADMIN', action_required=1, updated_at=datetime('now') WHERE id=?`).bind(threadId).run();
    await auditDev(env, ms.developer.id, userId, 'developer_admin_message_sent', { threadId });
    await notifyAdmins(env, `Developer reply: ${thread.subject}`, 'A developer replied to a communication thread.', { threadId });
    return { success: true };
  },
};

// ---------------------------------------------------------------------------
// Admin routes (gated by index.ts: every /admin/* request carries an admin JWT)
// ---------------------------------------------------------------------------

function applicantView(app: any, user: any) {
  return {
    id: app.id, status: app.status, publisherName: app.publisher_name,
    developerType: app.developer_type, contactEmail: app.contact_email,
    supportEmail: app.support_email, website: app.website, country: app.country,
    description: app.description, category: app.category,
    acceptedTerms: !!app.accepted_terms, termsAcceptedAt: app.terms_accepted_at,
    submittedAt: app.submitted_at, reviewedAt: app.reviewed_at,
    reviewReason: app.review_reason, createdAt: app.created_at,
    applicant: user ? { id: user.id, name: user.name, email: user.email } : null,
  };
}

export const adminDeveloperRoutes = {

  /** GET /admin/developers/applications?status= */
  async listApplications(request: Request, env: any) {
    const status = new URL(request.url).searchParams.get('status') || '';
    const rows: any = await env.DB.prepare(
      `SELECT a.*, u.name AS user_name, u.email AS user_email FROM developer_applications a
       LEFT JOIN users u ON u.id = a.user_id
       ${status ? 'WHERE a.status=?' : ''} ORDER BY a.updated_at DESC LIMIT 200`
    ).bind(...(status ? [status] : [])).all().catch(() => ({ results: [] }));
    return { applications: (rows?.results || []).map((a: any) => applicantView(a, { id: a.user_id, name: a.user_name, email: a.user_email })) };
  },

  /** GET /admin/developers/applications/:id */
  async getApplication(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE id=?').bind(id).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };
    const user: any = await env.DB.prepare('SELECT id, name, email FROM users WHERE id=?').bind(app.user_id).first().catch(() => null);
    const org: any = await env.DB.prepare('SELECT id, status, created_at FROM developers WHERE application_id=?').bind(id).first().catch(() => null);
    return { application: applicantView(app, user), organization: org || null };
  },

  /** POST /admin/developers/applications/:id/review — SUBMITTED -> UNDER_REVIEW. */
  async startReview(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE id=?').bind(id).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };
    if (app.status !== 'SUBMITTED') return { error: `Only submitted applications can move to review (current: ${app.status})`, code: 'FORBIDDEN' };
    await env.DB.prepare(`UPDATE developer_applications SET status='UNDER_REVIEW', updated_at=datetime('now') WHERE id=?`).bind(id).run();
    await auditGlobal(env, 'developer_application_review_started', id, {});
    await notify(env, app.user_id, 'system', 'Application under review', 'Your developer application is now under review.');
    return { application: { id, status: 'UNDER_REVIEW' } };
  },

  /**
   * POST /admin/developers/applications/:id/approve
   * Creates the developer identity, public profile, OWNER membership and
   * connects the applicant's existing marketplace apps to the organization.
   */
  async approveApplication(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE id=?').bind(id).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(app.status)) {
      return { error: `Only submitted or under-review applications can be approved (current: ${app.status})`, code: 'FORBIDDEN' };
    }

    const devId = newDeveloperId();
    await env.DB.prepare(
      `INSERT INTO developers (id, user_id, application_id, status) VALUES (?,?,?, 'ACTIVE')`
    ).bind(devId, app.user_id, id).run();
    await env.DB.prepare(
      `INSERT INTO developer_profiles (developer_id, publisher_name, description, website, support_url) VALUES (?,?,?,?,?)`
    ).bind(devId, app.publisher_name, app.description, app.website,
      app.support_email ? `mailto:${app.support_email}` : null).run();
    await env.DB.prepare(
      `INSERT INTO developer_members (id, developer_id, user_id, role) VALUES (?,?,?, 'OWNER')`
    ).bind(rid('dm'), devId, app.user_id).run();
    // Connect existing marketplace apps created by this account to the org.
    await env.DB.prepare(
      `UPDATE applications SET developer_org_id=? WHERE developer_id=? AND developer_org_id IS NULL`
    ).bind(devId, app.user_id).run().catch(() => {});
    await env.DB.prepare(
      `UPDATE developer_applications SET status='APPROVED', reviewed_at=datetime('now'), review_reason=NULL, updated_at=datetime('now') WHERE id=?`
    ).bind(id).run();

    await auditDev(env, devId, app.user_id, 'developer_application_approved', { applicationId: id });
    await auditGlobal(env, 'developer_application_approved', devId, { applicationId: id, userId: app.user_id });
    await notify(env, app.user_id, 'system', 'Developer application approved 🎉', 'Your developer organization is live. Welcome to the RX Store Developer Center.', { link: '/developers/center' });
    return { developer: { id: devId, status: 'ACTIVE' }, application: { id, status: 'APPROVED' } };
  },

  /** POST /admin/developers/applications/:id/reject — reason REQUIRED. */
  async rejectApplication(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A rejection reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE id=?').bind(id).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };
    if (app.status === 'APPROVED') return { error: 'This application is already approved — suspend the developer instead', code: 'FORBIDDEN' };
    await env.DB.prepare(
      `UPDATE developer_applications SET status='REJECTED', reviewed_at=datetime('now'), review_reason=?, reviewed_by=?, updated_at=datetime('now') WHERE id=?`
    ).bind(reason, userIdOf(request), id).run();
    await auditGlobal(env, 'developer_application_rejected', id, { reason });
    await notify(env, app.user_id, 'system', 'Developer application not approved', `Your application was not approved. Reason: ${reason}`);
    return { application: { id, status: 'REJECTED' } };
  },

  /** POST /admin/developers/applications/:id/request-changes — reason REQUIRED. */
  async requestChanges(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[4] || '';
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A change request reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const app: any = await env.DB.prepare('SELECT * FROM developer_applications WHERE id=?').bind(id).first().catch(() => null);
    if (!app) return { error: 'Application not found', code: 'NOT_FOUND' };
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(app.status)) {
      return { error: `Changes can only be requested on submitted/under-review applications (current: ${app.status})`, code: 'FORBIDDEN' };
    }
    await env.DB.prepare(
      `UPDATE developer_applications SET status='CHANGES_REQUESTED', reviewed_at=datetime('now'), review_reason=?, reviewed_by=?, updated_at=datetime('now') WHERE id=?`
    ).bind(reason, userIdOf(request), id).run();
    await auditGlobal(env, 'developer_application_changes_requested', id, { reason });
    await notify(env, app.user_id, 'system', 'Changes requested on your application', `Please update your application and resubmit. Reason: ${reason}`);
    return { application: { id, status: 'CHANGES_REQUESTED' } };
  },

  /** GET /admin/developers — organizations overview. */
  async listDevelopers(request: Request, env: any) {
    const rows: any = await env.DB.prepare(
      `SELECT d.id, d.status, d.created_at, p.publisher_name, p.logo,
              (SELECT COUNT(*) FROM developer_members m WHERE m.developer_id=d.id) AS member_count,
              (SELECT COUNT(*) FROM applications a WHERE a.developer_org_id=d.id) AS app_count
       FROM developers d LEFT JOIN developer_profiles p ON p.developer_id=d.id
       ORDER BY d.created_at DESC LIMIT 200`
    ).all().catch(() => ({ results: [] }));
    return { developers: rows?.results || [] };
  },

  /** GET /admin/developers/:id — org detail incl. members + audit. */
  async getDeveloper(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[3] || '';
    const dev: any = await env.DB.prepare('SELECT * FROM developers WHERE id=?').bind(id).first().catch(() => null);
    if (!dev) return { error: 'Developer not found', code: 'NOT_FOUND' };
    const profile: any = await env.DB.prepare('SELECT * FROM developer_profiles WHERE developer_id=?').bind(id).first().catch(() => null);
    const members: any = await env.DB.prepare(
      `SELECT m.role, m.created_at, u.id AS user_id, u.name, u.email FROM developer_members m JOIN users u ON u.id=m.user_id WHERE m.developer_id=?`
    ).bind(id).all().catch(() => ({ results: [] }));
    const audit: any = await env.DB.prepare(
      'SELECT action, actor_user_id, details, created_at FROM developer_audit_logs WHERE developer_id=? ORDER BY created_at DESC LIMIT 100'
    ).bind(id).all().catch(() => ({ results: [] }));
    return {
      developer: {
        id: dev.id, status: dev.status, createdAt: dev.created_at,
        suspendedReason: dev.suspended_reason || null,
        profile: profile || null,
        members: members?.results || [],
        audit: audit?.results || [],
      },
    };
  },

  /** POST /admin/developers/:id/suspend — reason REQUIRED; kills invitations too. */
  async suspendDeveloper(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[3] || '';
    const reason = str((await bodyOf(request)).reason, 1000);
    if (reason.length < 10) return { error: 'A suspension reason of at least 10 characters is required', code: 'VALIDATION_ERROR' };
    const dev: any = await env.DB.prepare('SELECT * FROM developers WHERE id=?').bind(id).first().catch(() => null);
    if (!dev) return { error: 'Developer not found', code: 'NOT_FOUND' };
    if (dev.status === 'SUSPENDED') return { error: 'This developer is already suspended', code: 'VALIDATION_ERROR' };

    await env.DB.prepare(`UPDATE developers SET status='SUSPENDED', suspended_reason=?, updated_at=datetime('now') WHERE id=?`).bind(reason, id).run();
    if (dev.application_id) {
      await env.DB.prepare(`UPDATE developer_applications SET status='SUSPENDED', review_reason=?, updated_at=datetime('now') WHERE id=?`).bind(reason, dev.application_id).run().catch(() => {});
    }
    // Invalidate outstanding invitations for this org.
    await env.DB.prepare(`UPDATE developer_invitations SET status='EXPIRED' WHERE developer_id=? AND status='PENDING'`).bind(id).run().catch(() => {});
    await auditDev(env, id, userIdOf(request), 'developer_suspended', { reason });
    await auditGlobal(env, 'developer_suspended', id, { reason });
    const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?').bind(id).all().catch(() => ({ results: [] }));
    for (const m of members?.results || []) {
      await notify(env, m.user_id, 'system', 'Developer organization suspended', `Your developer organization was suspended. Reason: ${reason}`);
    }
    return { developer: { id, status: 'SUSPENDED' } };
  },

  /** POST /admin/developers/:id/reinstate */
  async reinstateDeveloper(request: Request, env: any) {
    const id = new URL(request.url).pathname.split('/')[3] || '';
    const dev: any = await env.DB.prepare('SELECT * FROM developers WHERE id=?').bind(id).first().catch(() => null);
    if (!dev) return { error: 'Developer not found', code: 'NOT_FOUND' };
    if (dev.status !== 'SUSPENDED') return { error: 'This developer is not suspended', code: 'VALIDATION_ERROR' };
    await env.DB.prepare(`UPDATE developers SET status='ACTIVE', suspended_reason=NULL, updated_at=datetime('now') WHERE id=?`).bind(id).run();
    if (dev.application_id) {
      await env.DB.prepare(`UPDATE developer_applications SET status='APPROVED', updated_at=datetime('now') WHERE id=?`).bind(dev.application_id).run().catch(() => {});
    }
    await auditDev(env, id, userIdOf(request), 'developer_reinstated', {});
    await auditGlobal(env, 'developer_reinstated', id, {});
    const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?').bind(id).all().catch(() => ({ results: [] }));
    for (const m of members?.results || []) {
      await notify(env, m.user_id, 'system', 'Developer organization reinstated', 'Your developer organization is active again.');
    }
    return { developer: { id, status: 'ACTIVE' } };
  },

  /** GET /admin/developers/communications — all threads. */
  async adminListThreads(request: Request, env: any) {
    const rows: any = await env.DB.prepare(
      `SELECT t.*, p.publisher_name,
              (SELECT COUNT(*) FROM developer_thread_messages m WHERE m.thread_id=t.id AND m.sender_context='DEVELOPER' AND m.read_by_admin_at IS NULL) AS unread
       FROM developer_threads t LEFT JOIN developer_profiles p ON p.developer_id=t.developer_id
       ORDER BY t.updated_at DESC LIMIT 100`
    ).all().catch(() => ({ results: [] }));
    return { threads: rows?.results || [] };
  },

  /** GET /admin/developers/communications/:threadId — messages (marks dev msgs read). */
  async adminGetThread(request: Request, env: any) {
    // /admin/developers/communications/:threadId -> segment 4
    const threadId = new URL(request.url).pathname.split('/')[4] || '';
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=?').bind(threadId).first().catch(() => null);
    if (!thread) return { error: 'Thread not found', code: 'NOT_FOUND' };
    const messages: any = await env.DB.prepare(
      'SELECT id, sender_user_id, sender_context, body, attachments, created_at FROM developer_thread_messages WHERE thread_id=? ORDER BY created_at ASC'
    ).bind(threadId).all().catch(() => ({ results: [] }));
    await env.DB.prepare(
      `UPDATE developer_thread_messages SET read_by_admin_at=datetime('now') WHERE thread_id=? AND sender_context='DEVELOPER' AND read_by_admin_at IS NULL`
    ).bind(threadId).run().catch(() => {});
    return { thread, messages: messages?.results || [] };
  },

  /** POST /admin/developers/communications/:threadId/messages */
  async adminSendMessage(request: Request, env: any) {
    // /admin/developers/communications/:threadId/messages -> segment 4
    const threadId = new URL(request.url).pathname.split('/')[4] || '';
    const thread: any = await env.DB.prepare('SELECT * FROM developer_threads WHERE id=?').bind(threadId).first().catch(() => null);
    if (!thread) return { error: 'Thread not found', code: 'NOT_FOUND' };
    if (thread.status === 'CLOSED') return { error: 'This thread is closed', code: 'FORBIDDEN' };
    const body = await bodyOf(request);
    const message = str(body.message, 5000);
    const status = ['OPEN', 'AWAITING_DEVELOPER', 'AWAITING_ADMIN', 'RESOLVED', 'CLOSED'].includes(String(body.status)) ? String(body.status) : 'AWAITING_DEVELOPER';
    if (!message) return { error: 'Message is required', code: 'VALIDATION_ERROR' };

    const adminId = userIdOf(request);
    await env.DB.prepare(
      `INSERT INTO developer_thread_messages (id, thread_id, sender_user_id, sender_context, body) VALUES (?,?,?, 'ADMIN', ?)`
    ).bind(rid('dmsg'), threadId, adminId, message).run();
    await env.DB.prepare(
      `UPDATE developer_threads SET status=?, action_required=?, updated_at=datetime('now') WHERE id=?`
    ).bind(status, status === 'AWAITING_DEVELOPER' ? 1 : 0, threadId).run();
    await auditDev(env, thread.developer_id, adminId, 'developer_admin_message_sent', { threadId, by: 'admin' });
    // Notify every member of the organization.
    const members: any = await env.DB.prepare('SELECT user_id FROM developer_members WHERE developer_id=?').bind(thread.developer_id).all().catch(() => ({ results: [] }));
    for (const m of members?.results || []) {
      await notify(env, m.user_id, 'message', `RX Store replied: ${thread.subject}`, message.slice(0, 200), { threadId });
    }
    return { success: true };
  },
};

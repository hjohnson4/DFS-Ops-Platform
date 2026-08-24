import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "./supabase";
import type { Profile, Role } from "@shared/schema";

// Augment Express Request with the authenticated profile
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      profile?: Profile;
      accessToken?: string;
    }
  }
}

/**
 * requireAuth — verifies the Bearer token via Supabase Auth, loads the
 * caller's profile row, and attaches it to req. Rejects inactive users.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (!token) return res.status(401).json({ message: "Not authenticated" });

    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    // Load profile
    const { data: profile, error: pErr } = await supabaseAnon
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    if (pErr || !profile) {
      return res.status(403).json({ message: "No profile found for this account" });
    }
    if (!profile.active) {
      return res.status(403).json({ message: "This account has been deactivated" });
    }

    // Surface the "must change password" flag from Supabase Auth user_metadata.
    // It lives on the auth user (not the profiles table), so no DB column is
    // needed. The client uses it to force a password change before app access.
    const mustChange = !!(data.user.user_metadata as any)?.must_change_password;

    req.profile = { ...(profile as Profile), must_change_password: mustChange };
    req.accessToken = token;
    next();
  } catch (e) {
    console.error("[auth] error", e);
    res.status(500).json({ message: "Auth check failed" });
  }
}

/** requireRole — gate a route to specific roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.profile) return res.status(401).json({ message: "Not authenticated" });
    if (!roles.includes(req.profile.role)) {
      return res.status(403).json({ message: "You don't have permission for this action" });
    }
    next();
  };
}

/** Area managers & supervisors are scoped to their own area. */
export function areaScopeOf(p: Profile): string | null {
  if (p.role === "admin") return null; // sees all areas
  return p.area;
}

/**
 * jobScopeOf — determines which jobs a caller may see.
 *
 * Only field techs are narrowed to specific jobs. A field tech who has been
 * assigned to one or more jobs sees ONLY those jobs (and data tied to them).
 * A field tech with NO assignments falls back to their area view (returns
 * null, meaning "do not restrict by job id"). Every other role
 * (admin/area/super) also returns null and keeps the existing area scoping.
 *
 * Returns:
 *   - string[] : restrict queries to these job ids (field tech, assigned)
 *   - null     : do not restrict by job id (all non-field roles, and
 *                unassigned field techs falling back to area view)
 */
export async function jobScopeOf(p: Profile): Promise<string[] | null> {
  if (p.role !== "field") return null;
  const { data, error } = await supabaseAnon
    .from("job_assignments")
    .select("job_id")
    .eq("profile_id", p.id);
  if (error) {
    // Fail closed for field techs: an error must not widen their view.
    console.error("[auth] jobScopeOf error", error);
    return [];
  }
  const ids = (data || []).map((r: { job_id: string }) => r.job_id);
  // No assignments -> fall back to area view (null = unrestricted by job).
  return ids.length > 0 ? ids : null;
}

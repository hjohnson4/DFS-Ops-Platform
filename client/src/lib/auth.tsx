import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  apiRequest,
  setAccessToken,
  getAccessToken,
  setSession,
  refreshSession,
  hasRememberedLogin,
  setRememberedEmail,
  queryClient,
} from "./queryClient";
import type { Profile, NotificationPrefs } from "@shared/schema";

interface AuthState {
  profile: Profile | null;
  prefs: NotificationPrefs | null;
  loading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMe() {
    // "Remember me": no token in memory yet (fresh page load), but a saved
    // login exists — exchange it for a session silently.
    if (!getAccessToken() && hasRememberedLogin()) await refreshSession();
    if (!getAccessToken()) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const res = await apiRequest("GET", "/api/me");
      const data = await res.json();
      setProfile(data.profile);
      setPrefs(data.prefs);
    } catch (e: any) {
      // Only forget the login when the server says it's no good; a network
      // blip just shows the sign-in page and keeps the saved login.
      if (e?.status === 401 || e?.status === 403) setAccessToken(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMe();
  }, []);

  // Keep the session fresh while signed in (access tokens last ~1 hour).
  useEffect(() => {
    if (!profile) return;
    const id = window.setInterval(() => {
      refreshSession();
    }, 45 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [profile?.id]);

  async function login(email: string, password: string, remember = false) {
    const res = await apiRequest("POST", "/api/auth/login", { email, password });
    const data = await res.json();
    setSession(data.access_token, data.refresh_token, remember);
    setRememberedEmail(remember ? email : null);
    setProfile(data.profile);
    await loadMe();
  }

  function logout() {
    // Revoke this device's session on the server (best effort), then forget it.
    const t = getAccessToken();
    if (t)
      fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${t}` } }).catch(
        () => {},
      );
    setAccessToken(null);
    setProfile(null);
    setPrefs(null);
    queryClient.clear();
  }

  return (
    <AuthCtx.Provider
      value={{ profile, prefs, loading, login, logout, refresh: loadMe }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

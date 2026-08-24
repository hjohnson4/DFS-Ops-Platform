import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { apiRequest, setAccessToken, getAccessToken, queryClient } from "./queryClient";
import type { Profile, NotificationPrefs } from "@shared/schema";

interface AuthState {
  profile: Profile | null;
  prefs: NotificationPrefs | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMe() {
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
    } catch {
      setAccessToken(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMe();
  }, []);

  async function login(email: string, password: string) {
    const res = await apiRequest("POST", "/api/auth/login", { email, password });
    const data = await res.json();
    setAccessToken(data.access_token);
    setProfile(data.profile);
    await loadMe();
  }

  function logout() {
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

"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { apiLogin, apiMe, apiConfigured } from "@/lib/api";

// Standalone demo credentials (used when no backend is configured, or as a fallback).
const MOCK = {
  admin: { password: "ChangeMe!2026", role: "admin" },
  architect: { password: "star2026", role: "architect" },
};

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("star_session");
      if (raw) setUser(JSON.parse(raw));
    } catch {}
    setReady(true);
  }, []);

  const persist = (u) => {
    setUser(u);
    try {
      if (u) localStorage.setItem("star_session", JSON.stringify(u));
      else localStorage.removeItem("star_session");
    } catch {}
  };

  const login = async (username, password) => {
    if (apiConfigured()) {
      try {
        const tok = await apiLogin(username, password);
        if (tok) {
          localStorage.setItem("star_token", tok);
          const me = await apiMe();
          persist({ username: me?.username || username, role: me?.role || "architect" });
          return { ok: true };
        }
      } catch {
        // network/backend unavailable -> fall back to mock below
      }
    }
    const m = MOCK[username];
    if (m && m.password === password) {
      persist({ username, role: m.role });
      return { ok: true };
    }
    return { ok: false, error: "Invalid username or password." };
  };

  const logout = () => {
    persist(null);
    try { localStorage.removeItem("star_token"); } catch {}
  };

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

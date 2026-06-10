"use client";
import { useAuth } from "@/context/AuthContext";
import Login from "@/components/Login";
import StarApp from "@/components/StarApp";

export default function Page() {
  const { user, ready, logout } = useAuth();
  if (!ready) return null;
  if (!user) return <Login />;
  return <StarApp user={user} onLogout={logout} />;
}

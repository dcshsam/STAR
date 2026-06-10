"use client";
import { useState } from "react";
import { useAuth } from "@/context/AuthContext";

const C = { blue: "#7c5cff", blueDark: "#6536e0", ink: "#15171c", sub: "#6b7280", border: "#e7e5df", bg: "#f6f5f1" };

export default function Login() {
  const { login } = useAuth();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password) { setErr("Enter your username and password."); return; }
    setBusy(true); setErr("");
    const r = await login(username.trim(), password);
    setBusy(false);
    if (!r.ok) setErr(r.error || "Sign in failed.");
  };
  const onKey = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="brandmark">STAR</div>
        <div className="brand-title">SAP Transformation Accelerator Roadmap</div>
        <div className="brand-sub">Sign in to assess a system and get a recommended transformation path.</div>
        <label className="lf">Username
          <input value={username} onChange={(e) => setU(e.target.value)} onKeyDown={onKey} placeholder="architect" autoComplete="username" />
        </label>
        <label className="lf">Password
          <input type="password" value={password} onChange={(e) => setP(e.target.value)} onKeyDown={onKey} placeholder="••••••••" autoComplete="current-password" />
        </label>
        {err && <div className="lerr">{err}</div>}
        <button className="lbtn" onClick={submit} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <div className="lhint">Demo access: <b>architect / star2026</b></div>
      </div>
      <style>{`
        .login-root{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 50% -10%, #efeaff 0%, ${C.bg} 55%);padding:24px;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
        .login-card{width:100%;max-width:392px;background:#fff;border:1px solid ${C.border};border-radius:20px;padding:34px 30px;box-shadow:0 18px 50px rgba(101,54,224,.10)}
        .brandmark{display:inline-flex;align-items:center;justify-content:center;font-weight:900;letter-spacing:1px;font-size:15px;color:#fff;background:linear-gradient(135deg,${C.blue},${C.blueDark});border-radius:12px;padding:9px 14px}
        .brand-title{margin-top:18px;font-size:18px;font-weight:800;color:${C.ink}}
        .brand-sub{margin-top:6px;font-size:13px;color:${C.sub};line-height:1.5;margin-bottom:22px}
        .lf{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${C.sub};margin-bottom:14px}
        .lf input{display:block;width:100%;margin-top:7px;box-sizing:border-box;padding:11px 13px;border:1px solid ${C.border};border-radius:11px;font-size:14px;font-family:inherit;color:${C.ink};outline:none;transition:border-color .12s}
        .lf input:focus{border-color:${C.blue}}
        .lerr{font-size:12.5px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:9px 12px;margin-bottom:14px}
        .lbtn{width:100%;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:800;color:#fff;background:linear-gradient(135deg,${C.blue},${C.blueDark});cursor:pointer;font-family:inherit;transition:opacity .12s}
        .lbtn:disabled{opacity:.6;cursor:default}
        .lhint{margin-top:16px;text-align:center;font-size:12px;color:${C.sub}}
      `}</style>
    </div>
  );
}

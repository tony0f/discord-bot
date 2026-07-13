import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { LayoutDashboard, ListChecks, Trophy, Settings2, LogOut, Loader2 } from "lucide-react";
import { api } from "./api.js";
import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Requests from "./pages/Requests.jsx";
import Leaderboard from "./pages/Leaderboard.jsx";
import Settings from "./pages/Settings.jsx";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/requests", label: "Requests", icon: ListChecks },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

function Shell({ children, onLogout }) {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 font-mono text-sm font-semibold text-primary">
            PR
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">Proposal Requests</p>
            <p className="text-xs text-ink-3">UMA · Admin</p>
          </div>
        </div>
        <nav className="mt-2 flex flex-1 flex-col gap-1 px-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors cursor-pointer ${
                  isActive
                    ? "bg-primary/15 font-medium text-primary"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`
              }
            >
              <Icon size={17} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={onLogout}
          className="mx-3 mb-4 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <LogOut size={17} strokeWidth={2} />
          Log out
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        <nav className="flex gap-1 overflow-x-auto border-b border-edge bg-surface px-3 py-2 md:hidden">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  isActive ? "bg-primary/15 font-medium text-primary" : "text-ink-2"
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <main className="mx-auto max-w-6xl p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState("checking"); // checking | in | out

  useEffect(() => {
    api
      .me()
      .then(() => setAuth("in"))
      .catch(() => setAuth("out"));
    const onUnauthorized = () => setAuth("out");
    window.addEventListener("pr:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pr:unauthorized", onUnauthorized);
  }, []);

  if (auth === "checking") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="animate-spin text-ink-3" size={28} aria-label="Loading" />
      </div>
    );
  }

  if (auth === "out") {
    return <Login onSuccess={() => setAuth("in")} />;
  }

  const logout = async () => {
    await api.logout().catch(() => {});
    setAuth("out");
  };

  return (
    <BrowserRouter>
      <Shell onLogout={logout}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}

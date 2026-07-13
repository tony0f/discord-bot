import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Button, EmptyState } from "../ui.jsx";

const FIELDS = [
  { key: "credit_window_hours", label: "Credit window (hours)", hint: "Time a request has to be proposed before it expires." },
  { key: "max_active_per_user", label: "Max active requests per user", hint: "Simultaneous pending/proposed requests allowed." },
  { key: "daily_request_limit", label: "Daily request limit per user", hint: "Requests per rolling 24 hours." },
  { key: "poll_interval_minutes", label: "Watcher poll interval (minutes)", hint: "How often market states are checked." },
];

export default function Settings() {
  const [values, setValues] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings().then((d) => setValues(d.settings)).catch((e) => setError(e.message));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const updates = {};
      for (const f of FIELDS) updates[f.key] = values[f.key];
      const d = await api.saveSettings(updates);
      setValues(d.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-3">Runtime configuration — same values as /pr-admin</p>
      </header>

      <Card>
        {error && !values ? (
          <EmptyState>Failed to load: {error}</EmptyState>
        ) : !values ? (
          <EmptyState>Loading…</EmptyState>
        ) : (
          <form onSubmit={save} className="space-y-5">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={f.key} className="mb-1.5 block text-xs font-medium text-ink-2">
                  {f.label}
                </label>
                <input
                  id={f.key}
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
                />
                <p className="mt-1 text-xs text-ink-3">{f.hint}</p>
              </div>
            ))}
            {error && values && (
              <p role="alert" className="rounded-lg bg-s-incorrect/10 px-3 py-2 text-xs text-s-incorrect">{error}</p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving}>Save changes</Button>
              {saved && <span role="status" className="text-sm" style={{ color: "var(--color-s-correct)" }}>✓ Saved</span>}
            </div>
          </form>
        )}
      </Card>

      <Card title="Dashboard channel" subtitle="The live board channel is set from Discord with /pr-admin set_dashboard_channel.">
        <p className="text-sm text-ink-2">
          Discord-side settings (dashboard channel, command registration) stay in Discord — everything numeric lives here.
        </p>
      </Card>
    </div>
  );
}

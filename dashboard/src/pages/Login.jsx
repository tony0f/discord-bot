import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api.js";
import { Button } from "../ui.jsx";

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-7">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <KeyRound size={22} strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Proposal Requests</h1>
            <p className="mt-0.5 text-sm text-ink-3">Admin dashboard — UMA</p>
          </div>
        </div>

        <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-ink-2">
          Password
        </label>
        <div className="flex gap-2">
          <input
            id="password"
            type={show ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
            placeholder="••••••••••••"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="cursor-pointer rounded-lg border border-edge bg-surface-2 px-3 text-xs text-ink-2 hover:text-ink"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-s-incorrect/10 px-3 py-2 text-xs text-s-incorrect">
            {error}
          </p>
        )}

        <Button type="submit" loading={loading} className="mt-5 w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}

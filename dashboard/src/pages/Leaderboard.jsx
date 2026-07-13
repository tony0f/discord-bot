import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { api } from "../api.js";
import { Card, EmptyState } from "../ui.jsx";

const MEDALS = ["text-s-pending", "text-ink-2", "text-accent"];

export default function Leaderboard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.leaderboard().then((d) => setRows(d.leaderboard)).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Leaderboard</h1>
        <p className="mt-0.5 text-sm text-ink-3">Settled requests, rolling 6 months · 🎓 = 5+ settled with ≥95% accuracy</p>
      </header>

      <Card className="overflow-x-auto p-0">
        {error ? (
          <EmptyState>Failed to load: {error}</EmptyState>
        ) : !rows ? (
          <EmptyState>Loading…</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>No settled requests in the last 6 months yet.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-medium">Rank</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 text-right font-medium">Correct</th>
                <th className="px-4 py-3 text-right font-medium">Incorrect</th>
                <th className="px-4 py-3 text-right font-medium">Accuracy</th>
                <th className="w-1/3 px-4 py-3 font-medium">
                  <span className="sr-only">Accuracy bar</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const qualified = r.settled >= 5 && r.accuracy >= 0.95;
                return (
                  <tr key={r.userId} className="border-b border-edge/60 last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 font-mono text-xs tabular-nums ${MEDALS[i] || "text-ink-3"}`}>
                        {i < 3 && <Trophy size={13} aria-hidden />}
                        {i + 1}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {r.username} {qualified && <span title="5+ settled with ≥95% accuracy">🎓</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums" style={{ color: "var(--color-s-correct)" }}>{r.correct}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums" style={{ color: "var(--color-s-incorrect)" }}>{r.incorrect}</td>
                    <td className="px-4 py-3 text-right font-mono font-medium tabular-nums">{(r.accuracy * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${(r.accuracy * 100).toFixed(1)}% accuracy`}>
                        <div className="h-full rounded-full" style={{ width: `${r.accuracy * 100}%`, background: "var(--color-s-correct)" }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

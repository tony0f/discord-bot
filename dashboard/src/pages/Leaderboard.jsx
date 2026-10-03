import { useEffect, useState } from "react";
import { Trophy, Phone, ShieldCheck, Pencil, Search } from "lucide-react";
import { api } from "../api.js";
import { Card, EmptyState, Button, Modal } from "../ui.jsx";

const MEDALS = ["text-s-pending", "text-ink-2", "text-accent"];

const shortWallet = (w) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "");

function FlagChip({ active, busy, onClick, icon: Icon, label, activeClass }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={label}
      aria-pressed={active}
      className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50 ${
        active ? activeClass : "border-edge bg-surface-2 text-ink-3 hover:text-ink"
      }`}
    >
      <Icon size={11} aria-hidden />
      {label}
    </button>
  );
}

export default function Leaderboard() {
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // row being edited (wallet/note)
  const [wallet, setWallet] = useState("");
  const [note, setNote] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    api.leaderboard().then((d) => setRows(d.leaderboard)).catch((e) => setError(e.message));
  }, []);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const saveFlags = async (row, updates) => {
    setBusyId(row.userId);
    try {
      const d = await api.updateUserFlags(row.userId, { username: row.username, ...updates });
      setRows((rs) => rs.map((x) => (x.userId === row.userId ? { ...x, flags: d.flags } : x)));
      return true;
    } catch (e) {
      flash(`Error: ${e.message}`);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const openEditor = (row) => {
    setEditing(row);
    setWallet(row.flags?.wallet || "");
    setNote(row.flags?.note || "");
  };

  const saveEditor = async () => {
    const ok = await saveFlags(editing, {
      wallet: wallet.trim() || null,
      note: note.trim() || null,
    });
    if (ok) {
      flash(`Saved details for ${editing.username}.`);
      setEditing(null);
    }
  };

  const visible = rows
    ? rows
        .map((r, i) => ({ ...r, rank: i + 1 }))
        .filter((r) => !search.trim() || r.username.toLowerCase().includes(search.trim().toLowerCase()))
    : null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Leaderboard</h1>
          <p className="mt-0.5 text-sm text-ink-3">
            {rows ? `${rows.length} user(s) with settled requests · ` : ""}rolling 6 months · 🎓 = 5+ settled with ≥95% accuracy ·
            whitelist tracking is internal (never shown in Discord)
          </p>
        </div>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user…"
            aria-label="Search users"
            className="w-56 rounded-lg border border-edge bg-surface py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>
      </header>

      <Card className="overflow-x-auto p-0">
        {error && !rows ? (
          <EmptyState>Failed to load: {error}</EmptyState>
        ) : !rows ? (
          <EmptyState>Loading…</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>No settled requests in the last 6 months yet.</EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState>No users match “{search}”.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-medium">Rank</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 text-right font-medium">Correct</th>
                <th className="px-4 py-3 text-right font-medium">Incorrect</th>
                <th className="px-4 py-3 text-right font-medium">Accuracy</th>
                <th className="w-1/6 px-4 py-3 font-medium">
                  <span className="sr-only">Accuracy bar</span>
                </th>
                <th className="px-4 py-3 font-medium">Whitelist tracking</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const qualified = r.settled >= 5 && r.accuracy >= 0.95;
                const flags = r.flags || {};
                const busy = busyId === r.userId;
                return (
                  <tr key={r.userId} className="border-b border-edge/60 last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 font-mono text-xs tabular-nums ${MEDALS[r.rank - 1] || "text-ink-3"}`}>
                        {r.rank <= 3 && <Trophy size={13} aria-hidden />}
                        {r.rank}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {r.username} {qualified && <span title="5+ settled with ≥95% accuracy">🎓</span>}
                      {flags.note && (
                        <p className="mt-0.5 max-w-52 truncate text-xs font-normal text-ink-3" title={flags.note}>
                          📝 {flags.note}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums" style={{ color: "var(--color-s-correct)" }}>{r.correct}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums" style={{ color: "var(--color-s-incorrect)" }}>{r.incorrect}</td>
                    <td className="px-4 py-3 text-right font-mono font-medium tabular-nums">{(r.accuracy * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${(r.accuracy * 100).toFixed(1)}% accuracy`}>
                        <div className="h-full rounded-full" style={{ width: `${r.accuracy * 100}%`, background: "var(--color-s-correct)" }} />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <FlagChip
                          active={flags.contacted}
                          busy={busy}
                          onClick={() => saveFlags(r, { contacted: !flags.contacted })}
                          icon={Phone}
                          label="Contacted"
                          activeClass="border-s-pending/60 bg-s-pending/15 text-s-pending"
                        />
                        <FlagChip
                          active={flags.whitelisted}
                          busy={busy}
                          onClick={() => saveFlags(r, { whitelisted: !flags.whitelisted })}
                          icon={ShieldCheck}
                          label="Whitelisted"
                          activeClass="border-s-correct/60 bg-s-correct/15 text-s-correct"
                        />
                        <button
                          onClick={() => openEditor(r)}
                          title="Wallet & note"
                          aria-label={`Edit wallet and note for ${r.username}`}
                          className="cursor-pointer rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                      {flags.wallet && (
                        <p className="mt-1 font-mono text-xs text-ink-3" title={flags.wallet}>
                          {shortWallet(flags.wallet)}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={`Whitelist details — ${editing.username}`} onClose={() => setEditing(null)}>
          <label htmlFor="wl-wallet" className="mb-1.5 block text-xs font-medium text-ink-2">
            Wallet included in the whitelist
          </label>
          <input
            id="wl-wallet"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x… (leave empty to clear)"
            autoFocus
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-primary"
          />
          <label htmlFor="wl-note" className="mb-1.5 mt-4 block text-xs font-medium text-ink-2">
            Internal note
          </label>
          <textarea
            id="wl-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. Contacted via DM on Sep 8, waiting for wallet…"
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={busyId === editing.userId} onClick={saveEditor}>Save</Button>
          </div>
        </Modal>
      )}

      {toast && (
        <div role="status" aria-live="polite" className="fixed bottom-5 right-5 z-50 rounded-lg border border-edge bg-surface-2 px-4 py-2.5 text-sm shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}

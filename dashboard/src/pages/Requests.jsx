import { useCallback, useEffect, useState } from "react";
import { Search, Flag, Ban, Eraser, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { api, STATUS_META } from "../api.js";
import { Card, StatusBadge, Button, Modal, EmptyState } from "../ui.jsx";

const PAGE_SIZE = 25;
const FILTERS = ["all", "pending", "proposed", "settled_correct", "settled_incorrect", "expired", "invalidated"];

function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Requests() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null); // { type: 'invalidate'|'warn'|'clear', request }
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(() => {
    api
      .requests({ status, search, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [status, search, page]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const runAction = async () => {
    setBusy(true);
    try {
      if (action.type === "invalidate") await api.invalidate(action.request.id, reason);
      if (action.type === "warn") await api.addWarning(action.request.id, reason);
      if (action.type === "clear") await api.clearWarnings(action.request.id);
      flash(
        action.type === "invalidate"
          ? `Request #${action.request.id} invalidated.`
          : action.type === "warn"
            ? `Warning added to #${action.request.id}.`
            : `Warnings cleared on #${action.request.id}.`,
      );
      setAction(null);
      setReason("");
      load();
    } catch (e) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Requests</h1>
          <p className="mt-0.5 text-sm text-ink-3">{data ? `${data.total} result(s)` : "Loading…"}</p>
        </div>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search market, user, or #id…"
            aria-label="Search requests"
            className="w-72 rounded-lg border border-edge bg-surface py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => {
              setStatus(f);
              setPage(0);
            }}
            className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              status === f
                ? "border-primary bg-primary/15 text-primary"
                : "border-edge bg-surface text-ink-2 hover:text-ink"
            }`}
          >
            {f === "all" ? "All" : STATUS_META[f]?.label || f}
          </button>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        {error ? (
          <EmptyState>Failed to load: {error}</EmptyState>
        ) : !data ? (
          <EmptyState>Loading…</EmptyState>
        ) : data.requests.length === 0 ? (
          <EmptyState>No requests match this filter.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-medium">#</th>
                <th className="px-4 py-3 font-medium">Market</th>
                <th className="px-4 py-3 font-medium">Requested as</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Integration</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Age</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.requests.map((r) => {
                const active = ["pending", "proposed"].includes(r.status);
                return (
                  <tr key={r.id} className="border-b border-edge/60 align-top transition-colors last:border-0 hover:bg-surface-2/50">
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-2">{r.id}</td>
                    <td className="max-w-sm px-4 py-3">
                      <a href={r.market_url} target="_blank" rel="noreferrer" className="group inline-flex items-start gap-1.5 hover:text-primary">
                        <span className="line-clamp-2">{r.market_question}</span>
                        <ExternalLink size={12} className="mt-1 shrink-0 text-ink-3 group-hover:text-primary" aria-hidden />
                      </a>
                      {r.reports.length > 0 && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-s-incorrect">
                          <Flag size={11} aria-hidden /> {r.reports.length} community warning{r.reports.length > 1 ? "s" : ""} —{" "}
                          <span className="font-normal text-ink-3">{r.reports[0].reporter_username}: “{r.reports[0].reason.slice(0, 60)}”</span>
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{r.requested_outcome}</span>
                      {r.status === "proposed" && r.proposed_outcome && (
                        <p className="mt-0.5 text-xs text-ink-3">
                          proposed: <span style={{ color: r.proposed_outcome === r.requested_outcome ? "var(--color-s-correct)" : "var(--color-s-pending)" }}>{r.proposed_outcome} {r.proposed_outcome === r.requested_outcome ? "✓" : "≠"}</span>
                        </p>
                      )}
                      {r.settled_outcome && (
                        <p className="mt-0.5 text-xs text-ink-3">
                          settled: <span style={{ color: r.settled_outcome === r.requested_outcome ? "var(--color-s-correct)" : "var(--color-s-incorrect)" }}>{r.settled_outcome}</span>
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{r.discord_username}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
                        {r.creation_source === "predict.fun" ? "Predict.fun" : "Polymarket"}
                      </span>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-3">{timeAgo(r.created_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          title="Add community warning"
                          aria-label={`Add warning to request ${r.id}`}
                          disabled={!active}
                          onClick={() => setAction({ type: "warn", request: r })}
                          className="cursor-pointer rounded-lg p-2 text-ink-3 transition-colors hover:bg-s-pending/15 hover:text-s-pending disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Flag size={15} />
                        </button>
                        <button
                          title="Clear warnings"
                          aria-label={`Clear warnings on request ${r.id}`}
                          disabled={r.reports.length === 0}
                          onClick={() => setAction({ type: "clear", request: r })}
                          className="cursor-pointer rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Eraser size={15} />
                        </button>
                        <button
                          title="Invalidate request"
                          aria-label={`Invalidate request ${r.id}`}
                          disabled={!active}
                          onClick={() => setAction({ type: "invalidate", request: r })}
                          className="cursor-pointer rounded-lg p-2 text-ink-3 transition-colors hover:bg-s-incorrect/15 hover:text-s-incorrect disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Ban size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {data && totalPages > 1 && (
        <footer className="flex items-center justify-between text-sm text-ink-2">
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="subtle" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
              <ChevronLeft size={15} /> Prev
            </Button>
            <Button variant="subtle" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
              Next <ChevronRight size={15} />
            </Button>
          </div>
        </footer>
      )}

      {action && (
        <Modal
          title={
            action.type === "invalidate"
              ? `Invalidate request #${action.request.id}`
              : action.type === "warn"
                ? `Add warning to #${action.request.id}`
                : `Clear warnings on #${action.request.id}`
          }
          onClose={() => {
            setAction(null);
            setReason("");
          }}
        >
          <p className="mb-3 text-sm text-ink-2 line-clamp-2">{action.request.market_question}</p>
          {action.type !== "clear" && (
            <>
              <label htmlFor="reason" className="mb-1.5 block text-xs font-medium text-ink-2">
                Reason (posted to Discord)
              </label>
              <textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
                placeholder={action.type === "invalidate" ? "Spam, bad faith, duplicate…" : "Why proposers should be careful…"}
              />
            </>
          )}
          {action.type === "clear" && (
            <p className="text-sm text-ink-2">
              This removes all {action.request.reports.length} community warning(s) and updates the Discord card.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" onClick={() => { setAction(null); setReason(""); }}>
              Cancel
            </Button>
            <Button
              variant={action.type === "invalidate" ? "danger" : "primary"}
              loading={busy}
              disabled={action.type !== "clear" && !reason.trim()}
              onClick={runAction}
            >
              {action.type === "invalidate" ? "Invalidate" : action.type === "warn" ? "Add warning" : "Clear warnings"}
            </Button>
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

import { useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { STATUS_META } from "./api.js";

export function Card({ title, subtitle, children, className = "" }) {
  return (
    <section className={`rounded-xl border border-edge bg-surface p-5 ${className}`}>
      {title && (
        <header className="mb-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, hint, accent = "var(--color-primary)" }) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: "var(--color-s-neutral)" };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-xs font-medium"
      style={{ color: meta.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Button({ children, variant = "primary", loading, className = "", ...props }) {
  const styles = {
    primary: "bg-primary text-white hover:bg-primary/85",
    subtle: "bg-surface-2 text-ink hover:bg-edge",
    danger: "bg-s-incorrect/15 text-s-incorrect hover:bg-s-incorrect/25",
  };
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="text-sm text-ink-2">{children}</p>
    </div>
  );
}

export function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs shadow-xl">
      {label && <p className="mb-1 font-medium text-ink">{label}</p>}
      {payload.map((entry) => (
        <p key={entry.dataKey || entry.name} className="flex items-center gap-2 text-ink-2">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color || entry.fill }} aria-hidden />
          {entry.name}: <span className="font-mono font-medium tabular-nums text-ink">{entry.value}</span>
        </p>
      ))}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { api, STATUS_META } from "../api.js";
import { Card, StatTile, EmptyState, ChartTooltip } from "../ui.jsx";

const GRID = "var(--color-edge)";
const TEXT = "var(--color-ink-3)";

export default function Overview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.overview().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <EmptyState>Failed to load: {error}</EmptyState>;
  if (!data) return <EmptyState>Loading…</EmptyState>;

  const { totals, statusCounts, daily, topUsers } = data;
  const active = statusCounts
    .filter((s) => ["pending", "proposed"].includes(s.status))
    .reduce((a, s) => a + s.count, 0);

  const donutData = statusCounts.map((s) => ({
    name: STATUS_META[s.status]?.label || s.status,
    value: s.count,
    color: STATUS_META[s.status]?.color || "var(--color-s-neutral)",
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="mt-0.5 text-sm text-ink-3">Proposal-requests system at a glance</p>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Active requests" value={active} hint="pending + proposed" accent="var(--color-s-pending)" />
        <StatTile label="Total requests" value={totals.requests} hint={`${totals.users} unique users`} />
        <StatTile label="Settled (6m)" value={totals.settled6m} hint="correct + incorrect" accent="var(--color-ink)" />
        <StatTile
          label="Global accuracy (6m)"
          value={totals.accuracy6m === null ? "—" : `${(totals.accuracy6m * 100).toFixed(1)}%`}
          accent="var(--color-s-correct)"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Requests per day" subtitle="Created, last 30 days" className="lg:col-span-3">
          {daily.length === 0 ? (
            <EmptyState>No data yet</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={daily} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: TEXT, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fill: TEXT, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: GRID }} />
                <Area type="monotone" dataKey="created" name="Created" stroke="var(--color-s-proposed)" strokeWidth={2} fill="var(--color-s-proposed)" fillOpacity={0.12} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Status distribution" subtitle="All time" className="lg:col-span-2">
          {donutData.length === 0 ? (
            <EmptyState>No data yet</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2} stroke="var(--color-surface)" strokeWidth={2}>
                  {donutData.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
                <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ color: "var(--color-ink-2)", fontSize: 12 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Outcomes per day" subtitle="Settled and expired, last 30 days" className="lg:col-span-3">
          {daily.length === 0 ? (
            <EmptyState>No data yet</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={daily} margin={{ top: 4, right: 4, left: -22, bottom: 0 }} barCategoryGap="35%">
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: TEXT, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fill: TEXT, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-surface-2)" }} />
                <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ color: "var(--color-ink-2)", fontSize: 12 }}>{v}</span>} />
                <Bar dataKey="correct" name="Correct" stackId="a" fill="var(--color-s-correct)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="incorrect" name="Incorrect" stackId="a" fill="var(--color-s-incorrect)" />
                <Bar dataKey="expired" name="Expired" stackId="a" fill="var(--color-s-neutral)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Top requesters" subtitle="By requests, excluding invalidated" className="lg:col-span-2">
          {topUsers.length === 0 ? (
            <EmptyState>No data yet</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topUsers} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" tick={{ fill: TEXT, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} allowDecimals={false} />
                <YAxis type="category" dataKey="username" width={92} tick={{ fill: "var(--color-ink-2)", fontSize: 12 }} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-surface-2)" }} />
                <Bar dataKey="requests" name="Requests" fill="var(--color-s-proposed)" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>
    </div>
  );
}

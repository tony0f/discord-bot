async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && !path.endsWith("/login")) {
    window.dispatchEvent(new Event("pr:unauthorized"));
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  login: (password) => request("/api/login", { method: "POST", body: { password } }),
  logout: () => request("/api/logout", { method: "POST" }),
  me: () => request("/api/me"),
  overview: () => request("/api/overview"),
  requests: (params) => request(`/api/requests?${new URLSearchParams(params)}`),
  invalidate: (id, reason) =>
    request(`/api/requests/${id}/invalidate`, { method: "POST", body: { reason } }),
  addWarning: (id, reason) =>
    request(`/api/requests/${id}/warnings`, { method: "POST", body: { reason } }),
  clearWarnings: (id) => request(`/api/requests/${id}/warnings`, { method: "DELETE" }),
  leaderboard: () => request("/api/leaderboard"),
  settings: () => request("/api/settings"),
  saveSettings: (updates) => request("/api/settings", { method: "PUT", body: updates }),
};

export const STATUS_META = {
  pending: { label: "Pending", color: "var(--color-s-pending)" },
  proposed: { label: "Proposed", color: "var(--color-s-proposed)" },
  settled_correct: { label: "Correct", color: "var(--color-s-correct)" },
  settled_incorrect: { label: "Incorrect", color: "var(--color-s-incorrect)" },
  expired: { label: "Expired", color: "var(--color-s-neutral)" },
  invalidated: { label: "Invalidated", color: "var(--color-s-neutral)" },
};

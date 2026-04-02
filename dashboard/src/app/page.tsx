"use client";

import { useEffect, useState, useCallback } from "react";

interface SiteStatus {
  name: string;
  url: string;
  team: string;
  region: string;
  tags: string[];
  sla_target: number;
  currentStatus: "up" | "down" | "unknown";
  lastChecked: string | null;
  lastLatency: number | null;
  uptime: Record<string, number | null>;
  avgLatency: Record<string, number | null>;
  totalChecks: number;
  totalIncidents: number;
  currentIncident: Record<string, unknown> | null;
  recentIncidents: Record<string, unknown>[];
  responseHistory: { t: string; l: number }[];
  regionCheck: Record<string, unknown> | null;
  alert_emails: string[];
}

interface StatusResponse {
  sites: SiteStatus[];
  lastUpdated: string | null;
  totalSites: number;
  sitesUp: number;
  sitesDown: number;
}

// ─── helpers ───
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function uptimeColor(v: number | null) {
  if (v == null) return "text-gray-400";
  if (v >= 99.9) return "text-green-500";
  if (v >= 99) return "text-green-600";
  if (v >= 95) return "text-yellow-500";
  return "text-red-500";
}

function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function latencyLabel(ms: number | null) {
  if (ms == null) return { text: "—", color: "text-gray-400" };
  if (ms < 300) return { text: `${ms}ms`, color: "text-green-500" };
  if (ms < 1000) return { text: `${ms}ms`, color: "text-yellow-500" };
  return { text: `${ms}ms`, color: "text-red-500" };
}

// ─── main ───
export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editSite, setEditSite] = useState<SiteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      setStatus(await r.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 30_000);
    return () => clearInterval(i);
  }, [refresh]);

  const remove = async (url: string, name: string) => {
    if (!confirm(`Remove "${name}"?`)) return;
    await fetch("/api/sites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    setSelected(null);
    refresh();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-gray-400">Loading...</div>;
  }

  const sites = status?.sites || [];
  const up = status?.sitesUp || 0;
  const down = status?.sitesDown || 0;
  const total = sites.length;

  return (
    <div className="min-h-screen bg-white">
      {/* ── top bar ── */}
      <header className="border-b border-gray-100 bg-white sticky top-0 z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-green-500 rounded-md flex items-center justify-center">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth="2.5"><path d="M5 12l5 5L20 7"/></svg>
            </div>
            <span className="font-semibold text-gray-900 text-lg">Site Monitor</span>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors cursor-pointer"
          >
            + Add Monitor
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* ── summary strip ── */}
        <div className="flex items-center gap-6 mb-6 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-gray-800">{total}</span>
            <span className="text-gray-400">monitors</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="font-semibold text-green-600">{up}</span>
            <span className="text-gray-400">up</span>
          </div>
          {down > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="font-semibold text-red-600">{down}</span>
              <span className="text-gray-400">down</span>
            </div>
          )}
          {status?.lastUpdated && (
            <span className="text-gray-300 text-xs ml-auto">
              Updated {timeAgo(status.lastUpdated)}
            </span>
          )}
        </div>

        {/* ── empty state ── */}
        {total === 0 && (
          <div className="text-center py-20">
            <div className="text-gray-300 text-5xl mb-4">+</div>
            <p className="text-gray-500 mb-4">No monitors yet</p>
            <button onClick={() => setShowAdd(true)} className="text-green-500 font-medium hover:underline cursor-pointer">
              Add your first monitor
            </button>
          </div>
        )}

        {/* ── monitor list ── */}
        <div className="space-y-px">
          {sites.map((site) => (
            <MonitorRow
              key={site.url}
              site={site}
              expanded={selected === site.url}
              onToggle={() => setSelected(selected === site.url ? null : site.url)}
              onRemove={() => remove(site.url, site.name)}
              onEdit={() => setEditSite(site)}
            />
          ))}
        </div>
      </div>

      {/* ── edit modal ── */}
      {editSite && (
        <EditMonitor
          site={editSite}
          onClose={() => setEditSite(null)}
          onSaved={() => { setEditSite(null); refresh(); }}
        />
      )}

      {/* ── add modal ── */}
      {showAdd && (
        <AddMonitor
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── uptime bar (90 segments like UptimeRobot) ───
function UptimeBar({ data }: { data: { t: string; l: number }[] }) {
  // Group into 30 buckets from response history
  const buckets = 30;
  if (data.length < 2) {
    return (
      <div className="flex gap-[1px] h-8 items-end">
        {Array.from({ length: buckets }).map((_, i) => (
          <div key={i} className="flex-1 bg-gray-100 rounded-sm h-full" />
        ))}
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.l), 1);
  const perBucket = Math.ceil(data.length / buckets);
  const grouped = Array.from({ length: buckets }).map((_, i) => {
    const slice = data.slice(i * perBucket, (i + 1) * perBucket);
    if (slice.length === 0) return null;
    const avg = slice.reduce((s, d) => s + d.l, 0) / slice.length;
    return avg;
  });

  return (
    <div className="flex gap-[1px] h-8 items-end">
      {grouped.map((avg, i) => {
        if (avg == null) return <div key={i} className="flex-1 bg-gray-100 rounded-sm h-full" />;
        const h = Math.max(15, (avg / max) * 100);
        const color = avg < 500 ? "bg-green-400" : avg < 1500 ? "bg-yellow-400" : "bg-red-400";
        return (
          <div
            key={i}
            className={`flex-1 ${color} rounded-sm transition-all`}
            style={{ height: `${h}%` }}
            title={`${Math.round(avg)}ms`}
          />
        );
      })}
    </div>
  );
}

// ─── single monitor row ───
function MonitorRow({
  site,
  expanded,
  onToggle,
  onRemove,
  onEdit,
}: {
  site: SiteStatus;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const isUp = site.currentStatus === "up";
  const isDown = site.currentStatus === "down";
  const lat = latencyLabel(site.lastLatency);
  const u24 = site.uptime["24h"];

  return (
    <div className={`border border-gray-100 rounded-lg mb-2 overflow-hidden transition-shadow ${expanded ? "shadow-sm" : ""}`}>
      {/* main row */}
      <div
        onClick={onToggle}
        className="flex items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-gray-50 transition-colors"
      >
        {/* status dot */}
        <span className={`w-3 h-3 rounded-full flex-shrink-0 ${isUp ? "bg-green-500" : isDown ? "bg-red-500" : "bg-gray-300"}`} />

        {/* name + url */}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 truncate">{site.name}</div>
          <div className="text-xs text-gray-400 truncate">{site.url}</div>
        </div>

        {/* uptime % */}
        <div className="text-right flex-shrink-0 w-20">
          <div className={`text-sm font-semibold ${uptimeColor(u24)}`}>
            {u24 != null ? `${u24.toFixed(1)}%` : "—"}
          </div>
          <div className="text-[10px] text-gray-400">24h</div>
        </div>

        {/* response time */}
        <div className="text-right flex-shrink-0 w-20">
          <div className={`text-sm font-semibold ${lat.color}`}>{lat.text}</div>
          <div className="text-[10px] text-gray-400">latency</div>
        </div>

        {/* status badge */}
        <div className="flex-shrink-0 w-16 text-right">
          <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${
            isUp ? "bg-green-50 text-green-600" : isDown ? "bg-red-50 text-red-600" : "bg-gray-100 text-gray-400"
          }`}>
            {isUp ? "Up" : isDown ? "Down" : "?"}
          </span>
        </div>
      </div>

      {/* expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-4 bg-gray-50/50">
          {/* uptime stats */}
          <div className="grid grid-cols-4 gap-4 mb-4">
            {(["24h", "7d", "30d", "90d"] as const).map((k) => (
              <div key={k} className="text-center">
                <div className={`text-lg font-bold ${uptimeColor(site.uptime[k])}`}>
                  {site.uptime[k] != null ? `${site.uptime[k]!.toFixed(2)}%` : "—"}
                </div>
                <div className="text-[10px] text-gray-400 uppercase">{k} uptime</div>
              </div>
            ))}
          </div>

          {/* response time chart */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">Response Time</span>
              <span className="text-xs text-gray-400">
                avg {site.avgLatency["24h"] ? `${site.avgLatency["24h"]}ms` : "—"} (24h)
              </span>
            </div>
            <UptimeBar data={site.responseHistory} />
          </div>

          {/* incidents with timestamps and duration */}
          <div className="mb-4">
            <div className="text-xs text-gray-400 mb-2">Incidents</div>
            {site.recentIncidents.length === 0 && !site.currentIncident && (
              <div className="text-xs text-gray-300">No downtime recorded</div>
            )}
            {site.currentIncident && (() => {
              const since = new Date(String(site.currentIncident.startedAt));
              const dur = Date.now() - since.getTime();
              return (
                <div className="text-xs bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="font-semibold text-red-700">Currently Down</span>
                    </div>
                    <span className="font-semibold text-red-600">{fmtDur(dur)}</span>
                  </div>
                  <div className="text-red-400 mt-1">
                    Down since {since.toLocaleString()} &middot; {String(site.currentIncident.error || "")}
                  </div>
                </div>
              );
            })()}
            {site.recentIncidents.slice(0, 10).map((inc, i) => {
              const start = new Date(String(inc.startedAt));
              const end = inc.endedAt ? new Date(String(inc.endedAt)) : null;
              const durMs = inc.durationMs as number || (end ? end.getTime() - start.getTime() : 0);
              return (
                <div key={i} className="text-xs border border-gray-100 rounded-lg px-4 py-2.5 mb-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      <span className="text-gray-700">
                        {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {end && <> → {end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
                      </span>
                    </div>
                    <span className="font-semibold text-gray-500">{durMs ? fmtDur(durMs) : "—"}</span>
                  </div>
                  {inc.error ? <div className="text-gray-400 mt-0.5">{String(inc.error)}</div> : null}
                </div>
              );
            })}
          </div>

          {/* alert emails */}
          <AlertEmailEditor url={site.url} emails={site.alert_emails || []} />

          {/* meta + actions */}
          <div className="flex items-center justify-between mt-3">
            <div className="text-[10px] text-gray-300 space-x-3">
              <span>{site.totalChecks.toLocaleString()} checks</span>
              <span>{site.totalIncidents} incident{site.totalIncidents !== 1 ? "s" : ""}</span>
              {site.lastChecked && <span>checked {timeAgo(site.lastChecked)}</span>}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="text-xs text-gray-400 hover:text-green-500 transition-colors cursor-pointer"
              >
                Edit
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                className="text-xs text-gray-300 hover:text-red-500 transition-colors cursor-pointer"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── inline email editor (shown in expanded row) ───
function AlertEmailEditor({ url, emails }: { url: string; emails: string[] }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(emails.join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const list = value.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    await fetch("/api/sites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, alert_emails: list }),
    });
    setSaving(false);
    setEditing(false);
  };

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">Alert Emails</span>
        {!editing && (
          <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="text-xs text-green-500 hover:underline cursor-pointer">
            {emails.length > 0 ? "Edit" : "+ Add emails"}
          </button>
        )}
      </div>
      {!editing ? (
        emails.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {emails.map((em, i) => (
              <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{em}</span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-300">No alert emails configured — using global default</div>
        )
      ) : (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="email1@example.com, email2@example.com"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
            rows={2}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-1">
            <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Cancel</button>
            <button onClick={save} disabled={saving} className="text-xs bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 disabled:opacity-50 cursor-pointer">
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── add monitor modal ───
function AddMonitor({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [emails, setEmails] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const autoName = (u: string) => {
    try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace("www.", ""); }
    catch { return ""; }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const finalUrl = url.startsWith("http") ? url : `https://${url}`;
    const emailList = emails.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    try {
      const r = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || autoName(url), url: finalUrl, alert_emails: emailList }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Failed"); return; }
      onAdded();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center pt-20 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Monitor</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 mb-1">URL *</label>
            <input
              type="text"
              value={url}
              onChange={(e) => { setUrl(e.target.value); if (!name) setName(""); }}
              placeholder="example.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Friendly Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName(url) || "My Website"}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Alert Emails</label>
            <textarea
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="sneha@example.com, dev@example.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
              rows={2}
            />
            <div className="text-[10px] text-gray-400 mt-1">Comma-separated. These people get notified when this site goes down or recovers.</div>
          </div>
          {error && <div className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {saving ? "Adding..." : "Create Monitor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── edit monitor modal ───
function EditMonitor({ site, onClose, onSaved }: { site: SiteStatus; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(site.name);
  const [url, setUrl] = useState(site.url);
  const [emails, setEmails] = useState((site.alert_emails || []).join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);

    let finalUrl = url;
    if (!finalUrl.startsWith("http")) finalUrl = `https://${finalUrl}`;

    const emailList = emails.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    try {
      const r = await fetch("/api/sites", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          original_url: site.url,
          name,
          url: finalUrl,
          alert_emails: emailList,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Failed to save"); return; }
      onSaved();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center pt-20 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Monitor</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 mb-1">URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Friendly Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Alert Emails</label>
            <textarea
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="sneha@example.com, dev@example.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
              rows={2}
            />
            <div className="text-[10px] text-gray-400 mt-1">Comma-separated. Leave empty to use global default.</div>
          </div>
          {error && <div className="text-red-500 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

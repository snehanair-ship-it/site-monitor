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
}

interface StatusResponse {
  sites: SiteStatus[];
  lastUpdated: string | null;
  totalSites: number;
  sitesUp: number;
  sitesDown: number;
}

export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error("Failed to fetch status:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleDelete = async (url: string, name: string) => {
    if (!confirm(`Remove "${name}" from monitoring?`)) return;
    await fetch("/api/sites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    fetchStatus();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-slate-400 text-lg">Loading dashboard...</div>
      </div>
    );
  }

  const allUp = status?.sitesDown === 0 && (status?.sitesUp || 0) > 0;
  const anyDown = (status?.sitesDown || 0) > 0;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Site Monitor</h1>
          <p className="text-sm text-slate-500 mt-1">
            Kilowott Engineering
            {status?.lastUpdated && (
              <> &middot; Updated {new Date(status.lastUpdated).toLocaleString()}</>
            )}
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors cursor-pointer"
        >
          + Add Site
        </button>
      </div>

      {/* Overall Status */}
      <div
        className={`rounded-xl p-5 mb-6 text-center font-semibold text-lg ${
          allUp
            ? "bg-green-50 text-green-700 border border-green-200"
            : anyDown
            ? "bg-red-50 text-red-700 border border-red-200"
            : "bg-slate-100 text-slate-600 border border-slate-200"
        }`}
      >
        {allUp
          ? "All Systems Operational"
          : anyDown
          ? "Partial Outage Detected"
          : status?.totalSites === 0
          ? "No sites configured — add one to get started"
          : "Checking..."}
      </div>

      {/* Stats Bar */}
      {(status?.totalSites || 0) > 0 && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Sites" value={status?.totalSites || 0} />
          <StatCard label="Up" value={status?.sitesUp || 0} color="text-green-600" />
          <StatCard label="Down" value={status?.sitesDown || 0} color={anyDown ? "text-red-600" : undefined} />
          <StatCard
            label="Incidents"
            value={status?.sites.reduce((s, site) => s + site.totalIncidents, 0) || 0}
          />
        </div>
      )}

      {/* Add Site Modal */}
      {showAddForm && (
        <AddSiteForm
          onClose={() => setShowAddForm(false)}
          onAdded={() => {
            setShowAddForm(false);
            fetchStatus();
          }}
        />
      )}

      {/* Site Cards */}
      <div className="space-y-4">
        {status?.sites.map((site) => (
          <SiteCard key={site.url} site={site} onDelete={handleDelete} />
        ))}
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-slate-400 mt-12 pb-8">
        Powered by Site Monitor &middot; Checks run every 5 minutes via GitHub Actions
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 text-center">
      <div className={`text-2xl font-bold ${color || "text-slate-800"}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </div>
  );
}

function UptimeBadge({ label, value }: { label: string; value: number | null }) {
  const color =
    value == null
      ? "text-slate-400"
      : value >= 99.9
      ? "text-green-600"
      : value >= 99
      ? "text-lime-600"
      : value >= 95
      ? "text-orange-500"
      : "text-red-600";
  return (
    <div className="text-center">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-base font-bold ${color}`}>
        {value != null ? value.toFixed(2) + "%" : "N/A"}
      </div>
    </div>
  );
}

function MiniChart({ data }: { data: { t: string; l: number }[] }) {
  if (data.length < 2) return <div className="text-xs text-slate-400">No data yet</div>;
  const max = Math.max(...data.map((d) => d.l), 1);
  return (
    <div className="flex items-end gap-[1px] h-10">
      {data.map((d, i) => {
        const h = (d.l / max) * 100;
        const color = d.l < 500 ? "bg-green-500" : d.l < 1500 ? "bg-orange-400" : "bg-red-500";
        return (
          <div
            key={i}
            className={`${color} rounded-t-sm min-w-[3px] flex-1`}
            style={{ height: `${Math.max(4, h)}%` }}
            title={`${new Date(d.t).toLocaleTimeString()} — ${d.l}ms`}
          />
        );
      })}
    </div>
  );
}

function SiteCard({
  site,
  onDelete,
}: {
  site: SiteStatus;
  onDelete: (url: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-sm transition-shadow">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span
            className={`w-3 h-3 rounded-full ${
              site.currentStatus === "up"
                ? "bg-green-500"
                : site.currentStatus === "down"
                ? "bg-red-500"
                : "bg-slate-300"
            }`}
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900">{site.name}</span>
              {site.team && (
                <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-medium rounded-full">
                  {site.team}
                </span>
              )}
              {site.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[10px] rounded-full"
                >
                  {t}
                </span>
              ))}
            </div>
            <a
              href={site.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline"
            >
              {site.url}
            </a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-sm font-semibold ${
              site.currentStatus === "up"
                ? "text-green-600"
                : site.currentStatus === "down"
                ? "text-red-600"
                : "text-slate-400"
            }`}
          >
            {site.currentStatus === "up"
              ? "Operational"
              : site.currentStatus === "down"
              ? "Down"
              : "Unknown"}
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-slate-400 hover:text-slate-600 text-sm cursor-pointer"
          >
            {expanded ? "Less" : "More"}
          </button>
          <button
            onClick={() => onDelete(site.url, site.name)}
            className="text-slate-300 hover:text-red-500 transition-colors cursor-pointer"
            title="Remove site"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Uptime badges */}
      <div className="grid grid-cols-4 gap-3 mb-3 bg-slate-50 rounded-lg p-3">
        <UptimeBadge label="24h" value={site.uptime["24h"]} />
        <UptimeBadge label="7d" value={site.uptime["7d"]} />
        <UptimeBadge label="30d" value={site.uptime["30d"]} />
        <UptimeBadge label="90d" value={site.uptime["90d"]} />
      </div>

      {/* Latency + chart */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400">Response Time</span>
        <span className="text-sm font-semibold text-slate-700">
          {site.lastLatency ? `${site.lastLatency}ms` : "—"}
        </span>
      </div>
      <MiniChart data={site.responseHistory} />

      {/* Expanded section */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[11px] text-slate-400">SLA Target</div>
              <div className="text-sm font-semibold">{site.sla_target}%</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Total Checks</div>
              <div className="text-sm font-semibold">{site.totalChecks.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Incidents</div>
              <div className={`text-sm font-semibold ${site.totalIncidents > 0 ? "text-red-600" : ""}`}>
                {site.totalIncidents}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-center bg-slate-50 rounded-lg p-3">
            <div>
              <div className="text-[11px] text-slate-400">Avg Latency (24h)</div>
              <div className="text-sm font-bold">
                {site.avgLatency["24h"] ? `${site.avgLatency["24h"]}ms` : "—"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Avg Latency (7d)</div>
              <div className="text-sm font-bold">
                {site.avgLatency["7d"] ? `${site.avgLatency["7d"]}ms` : "—"}
              </div>
            </div>
          </div>

          {site.regionCheck && (
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-[11px] text-slate-400 mb-1">Multi-Region Status</div>
              <div className="text-xs text-slate-600">
                {(site.regionCheck as Record<string, Record<string, unknown>>)?.ipBlockAnalysis
                  ? String(
                      (site.regionCheck as Record<string, Record<string, string>>).ipBlockAnalysis
                        ?.analysis || "No data"
                    )
                  : "No region data"}
              </div>
            </div>
          )}

          {site.recentIncidents.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-400 mb-2">Recent Incidents</div>
              <div className="space-y-1">
                {site.recentIncidents.map((inc, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-xs bg-red-50 rounded px-3 py-2"
                  >
                    <span className="text-slate-600">
                      {new Date(String(inc.startedAt)).toLocaleString()}
                    </span>
                    <span className="text-slate-500">{String(inc.error || "Unknown")}</span>
                    <span className={inc.endedAt ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                      {inc.endedAt ? "Resolved" : "Ongoing"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {site.lastChecked && (
            <div className="text-[11px] text-slate-400 text-right">
              Last checked: {new Date(site.lastChecked).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddSiteForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [team, setTeam] = useState("");
  const [region, setRegion] = useState("global");
  const [slaTarget, setSlaTarget] = useState("99.9");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          url: url.startsWith("http") ? url : `https://${url}`,
          team,
          region,
          sla_target: parseFloat(slaTarget),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          vitals_enabled: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to add site");
        return;
      }
      onAdded();
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 mx-4">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-slate-900">Add Site to Monitor</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl cursor-pointer">
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Site Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Company Website"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              URL <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Team</label>
              <input
                type="text"
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                placeholder="e.g. Frontend Team"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Region</label>
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="global">Global</option>
                <option value="us">US</option>
                <option value="eu">EU</option>
                <option value="ap">Asia Pacific</option>
                <option value="in">India</option>
                <option value="no">Norway</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">SLA Target (%)</label>
              <input
                type="number"
                step="0.1"
                min="90"
                max="100"
                value={slaTarget}
                onChange={(e) => setSlaTarget(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tags</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="production, client"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {error && (
            <div className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submitting ? "Adding..." : "Add Site"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

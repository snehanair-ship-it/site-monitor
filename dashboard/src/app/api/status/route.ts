import { NextResponse } from "next/server";
import { loadConfig, loadUptimeData } from "@/lib/config";

interface Check {
  timestamp: string;
  success: boolean;
  status: number | null;
  latency: number | null;
  error: string | null;
}

interface Incident {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string;
  checksDown: number;
}

interface SiteStore {
  name: string;
  url: string;
  checks: Check[];
  incidents: Incident[];
  currentIncident: Incident | null;
  stats: { totalChecks: number; successfulChecks: number };
}

function uptime(checks: Check[], hours: number): number | null {
  const cutoff = Date.now() - hours * 3600000;
  const rel = checks.filter((c) => new Date(c.timestamp).getTime() >= cutoff);
  if (!rel.length) return null;
  return (rel.filter((c) => c.success).length / rel.length) * 100;
}

function avgLatency(checks: Check[], hours: number): number | null {
  const cutoff = Date.now() - hours * 3600000;
  const rel = checks.filter((c) => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);
  if (!rel.length) return null;
  return Math.round(rel.reduce((s, c) => s + (c.latency || 0), 0) / rel.length);
}

/** Count incidents and total downtime within a time window */
function periodStats(incidents: Incident[], currentIncident: Incident | null, hoursBack: number) {
  const cutoff = Date.now() - hoursBack * 3600000;
  const relevant = incidents.filter((i) => new Date(i.startedAt).getTime() >= cutoff);

  let totalDowntimeMs = relevant.reduce((s, i) => s + (i.durationMs || 0), 0);
  let count = relevant.length;

  // Include ongoing incident
  if (currentIncident && new Date(currentIncident.startedAt).getTime() >= cutoff) {
    count += 1;
    totalDowntimeMs += Date.now() - new Date(currentIncident.startedAt).getTime();
  }

  return { incidents: count, downtimeMs: totalDowntimeMs };
}

/** Calculate how long the site has been continuously up (or down) */
function currentStreakMs(checks: Check[]): { status: "up" | "down" | "unknown"; durationMs: number } {
  if (checks.length === 0) return { status: "unknown", durationMs: 0 };

  const lastStatus = checks[checks.length - 1].success;
  let streakStart = checks.length - 1;

  for (let i = checks.length - 2; i >= 0; i--) {
    if (checks[i].success !== lastStatus) break;
    streakStart = i;
  }

  const startTime = new Date(checks[streakStart].timestamp).getTime();
  return {
    status: lastStatus ? "up" : "down",
    durationMs: Date.now() - startTime,
  };
}

export async function GET() {
  const config = loadConfig();
  const data = loadUptimeData() as {
    sites: Record<string, SiteStore>;
    lastUpdated: string | null;
  };

  const sites = (config.sites || []).map((sc) => {
    const store = data.sites?.[sc.url];
    const last = store?.checks?.[store.checks.length - 1] || null;
    const incidents = (store?.incidents || []) as Incident[];
    const currentIncident = (store?.currentIncident || null) as Incident | null;

    const streak = store ? currentStreakMs(store.checks) : { status: "unknown" as const, durationMs: 0 };

    const stats24h = store ? periodStats(incidents, currentIncident, 24) : { incidents: 0, downtimeMs: 0 };
    const stats7d = store ? periodStats(incidents, currentIncident, 168) : { incidents: 0, downtimeMs: 0 };
    const stats30d = store ? periodStats(incidents, currentIncident, 720) : { incidents: 0, downtimeMs: 0 };

    return {
      name: sc.name,
      url: sc.url,
      alert_emails: sc.alert_emails || [],
      paused: sc.paused || false,
      currentStatus: last ? (last.success ? "up" : "down") : "unknown",
      lastChecked: last?.timestamp || null,
      lastLatency: last?.latency || null,
      checkInterval: config.global?.check_interval_minutes || 5,
      streak,
      uptime: {
        "24h": store ? uptime(store.checks, 24) : null,
        "7d": store ? uptime(store.checks, 168) : null,
        "30d": store ? uptime(store.checks, 720) : null,
      },
      avgLatency: {
        "24h": store ? avgLatency(store.checks, 24) : null,
        "7d": store ? avgLatency(store.checks, 168) : null,
        "30d": store ? avgLatency(store.checks, 720) : null,
      },
      periodStats: {
        "24h": stats24h,
        "7d": stats7d,
        "30d": stats30d,
      },
      totalChecks: store?.stats?.totalChecks || 0,
      totalIncidents: incidents.length + (currentIncident ? 1 : 0),
      currentIncident,
      recentIncidents: [...incidents].reverse().slice(0, 10),
      responseHistory: store
        ? store.checks.filter((c) => c.success && c.latency != null).slice(-60).map((c) => ({ t: c.timestamp, l: c.latency as number }))
        : [],
    };
  });

  return NextResponse.json({
    sites,
    lastUpdated: data.lastUpdated,
    totalSites: sites.length,
    sitesUp: sites.filter((s) => s.currentStatus === "up").length,
    sitesDown: sites.filter((s) => s.currentStatus === "down").length,
  });
}

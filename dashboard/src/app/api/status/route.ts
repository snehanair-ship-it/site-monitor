import { NextResponse } from "next/server";
import { loadConfig, loadUptimeData } from "@/lib/config";

interface Check {
  timestamp: string;
  success: boolean;
  status: number | null;
  latency: number | null;
  error: string | null;
}

interface SiteStore {
  name: string;
  url: string;
  checks: Check[];
  incidents: Record<string, unknown>[];
  currentIncident: Record<string, unknown> | null;
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

export async function GET() {
  const config = loadConfig();
  const data = loadUptimeData() as {
    sites: Record<string, SiteStore>;
    lastUpdated: string | null;
  };

  const sites = (config.sites || []).map((sc) => {
    const store = data.sites?.[sc.url];
    const last = store?.checks?.[store.checks.length - 1] || null;

    return {
      name: sc.name,
      url: sc.url,
      team: sc.team,
      region: sc.region,
      tags: sc.tags || [],
      sla_target: sc.sla_target,
      currentStatus: last ? (last.success ? "up" : "down") : "unknown",
      lastChecked: last?.timestamp || null,
      lastLatency: last?.latency || null,
      uptime: {
        "24h": store ? uptime(store.checks, 24) : null,
        "7d": store ? uptime(store.checks, 168) : null,
        "30d": store ? uptime(store.checks, 720) : null,
        "90d": store ? uptime(store.checks, 2160) : null,
      },
      avgLatency: {
        "24h": store ? avgLatency(store.checks, 24) : null,
        "7d": store ? avgLatency(store.checks, 168) : null,
      },
      totalChecks: store?.stats?.totalChecks || 0,
      totalIncidents: (store?.incidents?.length || 0) + (store?.currentIncident ? 1 : 0),
      currentIncident: store?.currentIncident || null,
      recentIncidents: store ? [...(store.incidents || [])].reverse().slice(0, 5) : [],
      responseHistory: store
        ? store.checks.filter((c) => c.success && c.latency != null).slice(-60).map((c) => ({ t: c.timestamp, l: c.latency as number }))
        : [],
      regionCheck: null,
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

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

function calculateUptime(checks: Check[], hoursBack: number): number | null {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = checks.filter(
    (c) => new Date(c.timestamp).getTime() >= cutoff
  );
  if (relevant.length === 0) return null;
  const up = relevant.filter((c) => c.success).length;
  return (up / relevant.length) * 100;
}

function getAverageLatency(checks: Check[], hoursBack: number): number | null {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = checks.filter(
    (c) =>
      new Date(c.timestamp).getTime() >= cutoff &&
      c.success &&
      c.latency != null
  );
  if (relevant.length === 0) return null;
  const sum = relevant.reduce((acc, c) => acc + (c.latency || 0), 0);
  return Math.round(sum / relevant.length);
}

// GET /api/status — get status for all sites
export async function GET() {
  const config = loadConfig();
  const data = loadUptimeData() as {
    sites: Record<string, SiteStore>;
    regionChecks: Record<string, unknown[]>;
    lastUpdated: string | null;
  };

  const sites = (config.sites || []).map((siteConfig) => {
    const store = data.sites?.[siteConfig.url];
    const lastCheck = store?.checks?.[store.checks.length - 1] || null;

    return {
      name: siteConfig.name,
      url: siteConfig.url,
      team: siteConfig.team,
      region: siteConfig.region,
      tags: siteConfig.tags || [],
      sla_target: siteConfig.sla_target,
      currentStatus: lastCheck
        ? lastCheck.success
          ? "up"
          : "down"
        : "unknown",
      lastChecked: lastCheck?.timestamp || null,
      lastLatency: lastCheck?.latency || null,
      uptime: {
        "24h": store ? calculateUptime(store.checks, 24) : null,
        "7d": store ? calculateUptime(store.checks, 24 * 7) : null,
        "30d": store ? calculateUptime(store.checks, 24 * 30) : null,
        "90d": store ? calculateUptime(store.checks, 24 * 90) : null,
      },
      avgLatency: {
        "24h": store ? getAverageLatency(store.checks, 24) : null,
        "7d": store ? getAverageLatency(store.checks, 24 * 7) : null,
      },
      totalChecks: store?.stats?.totalChecks || 0,
      totalIncidents:
        (store?.incidents?.length || 0) + (store?.currentIncident ? 1 : 0),
      currentIncident: store?.currentIncident || null,
      recentIncidents: store
        ? [...(store.incidents || [])].reverse().slice(0, 5)
        : [],
      responseHistory: store
        ? store.checks
            .filter((c) => c.success && c.latency != null)
            .slice(-48)
            .map((c) => ({ t: c.timestamp, l: c.latency }))
        : [],
      regionCheck: data.regionChecks?.[siteConfig.url]
        ? (data.regionChecks[siteConfig.url] as unknown[]).slice(-1)[0]
        : null,
    };
  });

  // AIOps data (stored by monitor in _aiops key)
  const aiopsData = (data as Record<string, unknown>)._aiops as Record<string, unknown> | undefined;

  return NextResponse.json({
    sites,
    lastUpdated: data.lastUpdated,
    totalSites: sites.length,
    sitesUp: sites.filter((s) => s.currentStatus === "up").length,
    sitesDown: sites.filter((s) => s.currentStatus === "down").length,
    aiops: aiopsData || null,
  });
}

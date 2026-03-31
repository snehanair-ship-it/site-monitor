/**
 * Historical analytics — trend analysis, anomaly detection, and deployment correlation.
 *
 * Analyzes uptime data to surface:
 * - Response time trends (improving/degrading)
 * - Anomaly detection (sudden latency spikes)
 * - Deployment impact correlation (via GitHub API)
 * - Weekly performance summaries
 */

const fetch = globalThis.fetch || require('node-fetch');

const LOG_PREFIX = '[analytics]';

/**
 * Analyze response time trends over a period.
 * Compares recent window vs older window to detect degradation.
 */
function analyzeLatencyTrend(checks, hoursBack = 168) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = checks
    .filter(c => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);

  if (relevant.length < 20) {
    return { trend: 'insufficient_data', change: null, message: 'Not enough data for trend analysis.' };
  }

  const midpoint = Math.floor(relevant.length / 2);
  const olderHalf = relevant.slice(0, midpoint);
  const recentHalf = relevant.slice(midpoint);

  const avgOlder = olderHalf.reduce((s, c) => s + c.latency, 0) / olderHalf.length;
  const avgRecent = recentHalf.reduce((s, c) => s + c.latency, 0) / recentHalf.length;
  const changePercent = ((avgRecent - avgOlder) / avgOlder) * 100;

  let trend = 'stable';
  let message = `Response time stable (${Math.round(avgRecent)}ms avg).`;

  if (changePercent > 30) {
    trend = 'degrading';
    message = `Response time increased ${changePercent.toFixed(0)}% (${Math.round(avgOlder)}ms → ${Math.round(avgRecent)}ms). Investigate server performance.`;
  } else if (changePercent > 15) {
    trend = 'slightly_degrading';
    message = `Response time slightly increasing (+${changePercent.toFixed(0)}%). Monitor closely.`;
  } else if (changePercent < -15) {
    trend = 'improving';
    message = `Response time improved ${Math.abs(changePercent).toFixed(0)}% (${Math.round(avgOlder)}ms → ${Math.round(avgRecent)}ms).`;
  }

  return {
    trend,
    change: changePercent,
    avgOlder: Math.round(avgOlder),
    avgRecent: Math.round(avgRecent),
    sampleSize: relevant.length,
    message,
  };
}

/**
 * Detect latency anomalies (sudden spikes above normal).
 */
function detectAnomalies(checks, hoursBack = 24) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = checks
    .filter(c => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);

  if (relevant.length < 10) return { anomalies: [], message: 'Insufficient data.' };

  // Calculate mean and standard deviation
  const latencies = relevant.map(c => c.latency);
  const mean = latencies.reduce((s, l) => s + l, 0) / latencies.length;
  const variance = latencies.reduce((s, l) => s + Math.pow(l - mean, 2), 0) / latencies.length;
  const stdDev = Math.sqrt(variance);
  const threshold = mean + 2.5 * stdDev;

  const anomalies = relevant
    .filter(c => c.latency > threshold)
    .map(c => ({
      timestamp: c.timestamp,
      latency: c.latency,
      deviations: ((c.latency - mean) / stdDev).toFixed(1),
    }));

  return {
    anomalies,
    mean: Math.round(mean),
    stdDev: Math.round(stdDev),
    threshold: Math.round(threshold),
    message: anomalies.length > 0
      ? `${anomalies.length} latency anomalies detected (>${Math.round(threshold)}ms threshold).`
      : 'No anomalies detected.',
  };
}

/**
 * Calculate incident frequency and patterns.
 */
function analyzeIncidentPatterns(incidents) {
  if (!incidents || incidents.length === 0) {
    return { pattern: 'none', message: 'No incidents recorded.' };
  }

  // Group by hour of day
  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const inc of incidents) {
    const d = new Date(inc.startedAt);
    hourCounts[d.getUTCHours()] += 1;
    dayCounts[d.getUTCDay()] += 1;
  }

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const peakDay = dayCounts.indexOf(Math.max(...dayCounts));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Average incident duration
  const withDuration = incidents.filter(i => i.durationMs);
  const avgDuration = withDuration.length > 0
    ? withDuration.reduce((s, i) => s + i.durationMs, 0) / withDuration.length
    : null;

  // Incidents per week (last 30 days)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentIncidents = incidents.filter(i => new Date(i.startedAt).getTime() >= thirtyDaysAgo);
  const incidentsPerWeek = (recentIncidents.length / 4.3).toFixed(1);

  return {
    total: incidents.length,
    last30Days: recentIncidents.length,
    incidentsPerWeek,
    peakHour: `${peakHour}:00 UTC`,
    peakDay: dayNames[peakDay],
    avgDurationMs: avgDuration ? Math.round(avgDuration) : null,
    avgDurationStr: avgDuration ? formatDuration(avgDuration) : 'N/A',
    hourDistribution: hourCounts,
    dayDistribution: dayCounts,
    message: `${incidentsPerWeek} incidents/week. Peak: ${dayNames[peakDay]}s at ${peakHour}:00 UTC. Avg duration: ${avgDuration ? formatDuration(avgDuration) : 'N/A'}.`,
  };
}

/**
 * Fetch recent deployments from GitHub to correlate with incidents.
 */
async function fetchDeployments(repoOwner, repoName) {
  const token = process.env.GITHUB_TOKEN || '';
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/deployments?per_page=20`,
      { headers, timeout: 10000 }
    );
    if (!resp.ok) return [];
    const deployments = await resp.json();
    return deployments.map(d => ({
      id: d.id,
      environment: d.environment,
      ref: d.ref,
      createdAt: d.created_at,
      description: d.description,
    }));
  } catch {
    return [];
  }
}

/**
 * Correlate incidents with deployments.
 * Finds incidents that started within a time window after a deployment.
 */
function correlateWithDeployments(incidents, deployments, windowMinutes = 60) {
  if (!deployments.length || !incidents.length) return [];

  const correlations = [];

  for (const incident of incidents) {
    const incStart = new Date(incident.startedAt).getTime();

    for (const deploy of deployments) {
      const deployTime = new Date(deploy.createdAt).getTime();
      const timeDiff = (incStart - deployTime) / 60000; // minutes

      if (timeDiff >= 0 && timeDiff <= windowMinutes) {
        correlations.push({
          incident,
          deployment: deploy,
          minutesAfterDeploy: Math.round(timeDiff),
          correlation: timeDiff <= 15 ? 'strong' : timeDiff <= 30 ? 'moderate' : 'weak',
        });
      }
    }
  }

  return correlations;
}

/**
 * Generate a full analytics report for a site.
 */
function generateSiteAnalytics(store) {
  const latencyTrend = analyzeLatencyTrend(store.checks, 168); // 7 days
  const anomalies = detectAnomalies(store.checks, 24);
  const incidentPatterns = analyzeIncidentPatterns(store.incidents);

  return {
    latencyTrend,
    anomalies,
    incidentPatterns,
    summary: [
      latencyTrend.message,
      anomalies.message,
      incidentPatterns.message,
    ].join(' '),
  };
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

module.exports = {
  analyzeLatencyTrend,
  detectAnomalies,
  analyzeIncidentPatterns,
  fetchDeployments,
  correlateWithDeployments,
  generateSiteAnalytics,
};

/**
 * Generates a static HTML status page from uptime data.
 * Includes: uptime bars, response time charts, SLA tracking,
 * multi-region status, IP block detection, analytics, and incident history.
 *
 * Output: status-page/index.html
 */

const fs = require('fs');
const path = require('path');
const { loadData, getAllReports, getLatestRegionCheck } = require('./uptime-store');
const { generateSiteAnalytics } = require('./analytics');
const { checkSLARisk } = require('./sla-tracker');

let _config = null;
function getConfig() {
  if (_config) return _config;
  try { _config = require('./config-loader').loadConfig(); } catch { _config = {}; }
  return _config;
}

const OUTPUT_DIR = process.env.STATUS_PAGE_DIR || path.join(__dirname, 'status-page');

function formatDuration(ms) {
  if (ms == null) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function uptimeColor(pct) {
  if (pct == null) return '#9e9e9e';
  if (pct >= 99.9) return '#2e7d32';
  if (pct >= 99) return '#558b2f';
  if (pct >= 95) return '#ed6c02';
  return '#d32f2f';
}

function statusIcon(status) {
  if (status === 'up') return '<span style="color:#2e7d32;font-size:22px;">&#9679;</span>';
  if (status === 'down') return '<span style="color:#d32f2f;font-size:22px;">&#9679;</span>';
  return '<span style="color:#9e9e9e;font-size:22px;">&#9679;</span>';
}

function statusLabel(status) {
  if (status === 'up') return '<span style="color:#2e7d32;font-weight:600;">Operational</span>';
  if (status === 'down') return '<span style="color:#d32f2f;font-weight:600;">Down</span>';
  return '<span style="color:#9e9e9e;font-weight:600;">Unknown</span>';
}

function uptimeBadge(label, pct) {
  const display = pct != null ? pct.toFixed(2) + '%' : 'N/A';
  const color = uptimeColor(pct);
  return `<div style="text-align:center;"><div style="font-size:11px;color:#888;margin-bottom:2px;">${label}</div><div style="font-size:18px;font-weight:700;color:${color};">${display}</div></div>`;
}

function buildResponseTimeChart(history) {
  if (!history || history.length === 0) return '<p style="color:#999;font-size:13px;">No response time data yet.</p>';

  const maxLatency = Math.max(...history.map(h => h.avgLatency), 1);
  const barWidth = Math.max(4, Math.floor(600 / history.length) - 1);

  const bars = history.map(h => {
    const heightPct = (h.avgLatency / maxLatency) * 100;
    const color = h.avgLatency < 500 ? '#2e7d32' : h.avgLatency < 1500 ? '#ed6c02' : '#d32f2f';
    const time = new Date(h.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div title="${time} — ${h.avgLatency}ms" style="display:inline-block;width:${barWidth}px;height:${heightPct}%;background:${color};border-radius:2px 2px 0 0;margin:0 0.5px;vertical-align:bottom;"></div>`;
  }).join('');

  return `
    <div style="position:relative;height:80px;display:flex;align-items:flex-end;background:#fafafa;border-radius:6px;padding:8px 4px 4px;overflow:hidden;">
      ${bars}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;margin-top:2px;">
      <span>${history.length > 0 ? new Date(history[0].timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}</span>
      <span>Avg response time (24h)</span>
      <span>${history.length > 0 ? new Date(history[history.length - 1].timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}</span>
    </div>`;
}

function buildUptimeBar(checks, hoursBack) {
  const segments = 90;
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevantChecks = checks.filter(c => new Date(c.timestamp).getTime() >= cutoff);
  const segmentDuration = (hoursBack * 60 * 60 * 1000) / segments;

  const bars = [];
  for (let i = 0; i < segments; i++) {
    const segStart = cutoff + i * segmentDuration;
    const segEnd = segStart + segmentDuration;
    const segChecks = relevantChecks.filter(c => {
      const t = new Date(c.timestamp).getTime();
      return t >= segStart && t < segEnd;
    });

    let color = '#e0e0e0';
    if (segChecks.length > 0) {
      const upRatio = segChecks.filter(c => c.success).length / segChecks.length;
      if (upRatio >= 1) color = '#2e7d32';
      else if (upRatio >= 0.5) color = '#ed6c02';
      else color = '#d32f2f';
    }

    bars.push(`<div style="flex:1;height:28px;background:${color};border-radius:2px;margin:0 0.5px;" title="Segment ${i + 1}"></div>`);
  }

  return `<div style="display:flex;align-items:center;gap:0;margin:8px 0;">${bars.join('')}</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;">
      <span>${hoursBack >= 24 ? Math.round(hoursBack / 24) + ' days ago' : hoursBack + 'h ago'}</span>
      <span>Now</span>
    </div>`;
}

function buildIncidentRow(incident) {
  const start = new Date(incident.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const duration = incident.durationMs ? formatDuration(incident.durationMs) : 'Ongoing';
  const statusColor = incident.endedAt ? '#2e7d32' : '#d32f2f';
  const statusText = incident.endedAt ? 'Resolved' : 'Ongoing';

  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;">${start}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;">${duration}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#666;">${incident.error || '—'}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;"><span style="color:${statusColor};font-weight:600;font-size:12px;">${statusText}</span></td>
  </tr>`;
}

function buildSLASection(siteConfig, store) {
  if (!store) return '';
  const config = getConfig();
  const slaTarget = siteConfig?.sla_target || config.global?.default_sla_target || 99.9;
  const risk = checkSLARisk(store, slaTarget);

  const barWidth = risk.currentSLA != null ? Math.min(100, risk.currentSLA) : 0;
  const barColor = risk.breached ? '#d32f2f' : risk.atRisk ? '#ed6c02' : '#2e7d32';
  const statusText = risk.breached ? 'BREACHED' : risk.atRisk ? 'AT RISK' : 'ON TRACK';
  const statusColor = risk.breached ? '#d32f2f' : risk.atRisk ? '#ed6c02' : '#2e7d32';

  return `
    <div style="margin:16px 0;padding:16px;background:#fafafa;border-radius:8px;border-left:4px solid ${statusColor};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;color:#555;">SLA Compliance (This Month)</span>
        <span style="font-size:12px;font-weight:700;color:${statusColor};">${statusText}</span>
      </div>
      <div style="background:#e0e0e0;border-radius:4px;height:8px;overflow:hidden;margin-bottom:8px;">
        <div style="background:${barColor};height:100%;width:${barWidth}%;border-radius:4px;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#888;">
        <span>Current: <strong style="color:${statusColor};">${risk.currentSLA != null ? risk.currentSLA.toFixed(2) + '%' : 'N/A'}</strong></span>
        <span>Target: <strong>${slaTarget}%</strong></span>
        <span>Budget: <strong>${risk.remainingBudget} failures left</strong></span>
      </div>
    </div>`;
}

function buildRegionSection(data, siteUrl) {
  const regionCheck = getLatestRegionCheck(data, siteUrl);
  if (!regionCheck) return '';

  const analysis = regionCheck.ipBlockAnalysis;
  if (!analysis) return '';

  const globalResults = regionCheck.globalCheck?.results || [];
  if (globalResults.length === 0 && !analysis.blocked) return '';

  const statusColor = analysis.blocked ? '#d32f2f' : analysis.partialBlock ? '#ed6c02' : '#2e7d32';
  const statusText = analysis.blocked ? 'IP BLOCK DETECTED' : analysis.partialBlock ? 'PARTIAL BLOCK' : 'ALL REGIONS OK';

  const regionDots = globalResults.map(r => {
    const color = r.reachable ? '#2e7d32' : '#d32f2f';
    const label = r.location || r.nodeId;
    return `<div title="${label}: ${r.reachable ? 'Reachable' : 'Blocked'}" style="display:inline-flex;align-items:center;gap:4px;margin:2px 8px 2px 0;font-size:11px;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>
      <span style="color:#666;">${label}</span>
    </div>`;
  }).join('');

  return `
    <div style="margin:16px 0;padding:16px;background:#fafafa;border-radius:8px;border-left:4px solid ${statusColor};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;color:#555;">Multi-Region Status</span>
        <span style="font-size:12px;font-weight:700;color:${statusColor};">${statusText}</span>
      </div>
      ${regionCheck.runnerIP ? `<div style="font-size:11px;color:#888;margin-bottom:6px;">Runner IP: ${regionCheck.runnerIP}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;margin-bottom:6px;">${regionDots}</div>
      <div style="font-size:11px;color:#666;">${analysis.analysis}</div>
    </div>`;
}

function buildAnalyticsSection(store) {
  if (!store || !store.checks || store.checks.length < 20) return '';

  const analytics = generateSiteAnalytics(store);

  const trendColor = analytics.latencyTrend.trend === 'degrading' ? '#d32f2f'
    : analytics.latencyTrend.trend === 'improving' ? '#2e7d32'
    : analytics.latencyTrend.trend === 'slightly_degrading' ? '#ed6c02'
    : '#666';

  const trendIcon = analytics.latencyTrend.trend === 'degrading' ? '↗'
    : analytics.latencyTrend.trend === 'improving' ? '↘'
    : '→';

  // Incident pattern hour chart (mini)
  const hourDist = analytics.incidentPatterns.hourDistribution || [];
  const maxHour = Math.max(...hourDist, 1);
  const hourBars = hourDist.map((count, i) => {
    const h = (count / maxHour) * 20;
    const c = count > 0 ? '#ed6c02' : '#e0e0e0';
    return `<div title="${i}:00 — ${count} incidents" style="display:inline-block;width:8px;height:${Math.max(2, h)}px;background:${c};border-radius:1px;margin:0 0.5px;vertical-align:bottom;"></div>`;
  }).join('');

  return `
    <div style="margin:16px 0;padding:16px;background:#fafafa;border-radius:8px;">
      <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:10px;">Analytics</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;color:#888;">Latency Trend (7d)</div>
          <div style="font-size:14px;font-weight:600;color:${trendColor};">${trendIcon} ${analytics.latencyTrend.trend.replace('_', ' ')}</div>
          ${analytics.latencyTrend.change != null ? `<div style="font-size:11px;color:#888;">${analytics.latencyTrend.avgOlder}ms → ${analytics.latencyTrend.avgRecent}ms (${analytics.latencyTrend.change > 0 ? '+' : ''}${analytics.latencyTrend.change.toFixed(0)}%)</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;color:#888;">Anomalies (24h)</div>
          <div style="font-size:14px;font-weight:600;color:${analytics.anomalies.anomalies.length > 0 ? '#ed6c02' : '#2e7d32'};">${analytics.anomalies.anomalies.length} detected</div>
          ${analytics.anomalies.threshold ? `<div style="font-size:11px;color:#888;">Threshold: ${analytics.anomalies.threshold}ms</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;color:#888;">Incident Rate</div>
          <div style="font-size:14px;font-weight:600;color:#333;">${analytics.incidentPatterns.incidentsPerWeek || '0'}/week</div>
          <div style="font-size:11px;color:#888;">Avg duration: ${analytics.incidentPatterns.avgDurationStr || 'N/A'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#888;">Peak Incident Time</div>
          <div style="font-size:14px;font-weight:600;color:#333;">${analytics.incidentPatterns.peakDay || 'N/A'}</div>
          <div style="font-size:11px;color:#888;">${analytics.incidentPatterns.peakHour || ''}</div>
        </div>
      </div>
      ${hourDist.some(h => h > 0) ? `
      <div style="margin-top:10px;">
        <div style="font-size:11px;color:#888;margin-bottom:4px;">Incidents by hour (UTC)</div>
        <div style="display:flex;align-items:flex-end;height:24px;">${hourBars}</div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#bbb;">
          <span>0:00</span><span>12:00</span><span>23:00</span>
        </div>
      </div>` : ''}
    </div>`;
}

function buildSiteCard(report, data, siteConfig) {
  const store = data.sites[report.url];
  const checks = store ? store.checks : [];
  const incidents = report.recentIncidents || [];
  const ongoingIncident = report.currentIncident;

  const incidentRows = [];
  if (ongoingIncident) incidentRows.push(buildIncidentRow(ongoingIncident));
  incidents.forEach(inc => incidentRows.push(buildIncidentRow(inc)));

  const incidentTable = incidentRows.length > 0 ? `
    <h3 style="margin:20px 0 10px;font-size:14px;color:#555;">Recent Incidents</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f9f9f9;">
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;">STARTED</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;">DURATION</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;">ERROR</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;font-weight:600;">STATUS</th>
      </tr></thead>
      <tbody>${incidentRows.join('')}</tbody>
    </table>` : '<p style="color:#999;font-size:13px;margin-top:16px;">No incidents recorded.</p>';

  // Team badge
  const config = getConfig();
  const team = config.teams?.[siteConfig?.team];
  const teamBadge = team ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#e3f2fd;color:#1565c0;font-size:11px;font-weight:600;margin-left:8px;">${team.name}</span>` : '';

  // Tags
  const tags = (siteConfig?.tags || []).map(t =>
    `<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:#f5f5f5;color:#888;font-size:10px;margin-right:4px;">${t}</span>`
  ).join('');

  return `
    <div style="background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:24px;margin-bottom:20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${statusIcon(report.currentStatus)}
          <div>
            <div style="font-size:17px;font-weight:700;color:#222;">${report.name}${teamBadge}</div>
            <div><a href="${report.url}" style="font-size:12px;color:#1976d2;text-decoration:none;">${report.url}</a> ${tags}</div>
          </div>
        </div>
        <div>${statusLabel(report.currentStatus)}</div>
      </div>

      <!-- Uptime bar (30 days) -->
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;color:#888;margin-bottom:4px;">Uptime (30 days)</div>
        ${buildUptimeBar(checks, 24 * 30)}
      </div>

      <!-- Uptime percentages -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;padding:12px;background:#fafafa;border-radius:8px;">
        ${uptimeBadge('24 hours', report.uptime['24h'])}
        ${uptimeBadge('7 days', report.uptime['7d'])}
        ${uptimeBadge('30 days', report.uptime['30d'])}
        ${uptimeBadge('90 days', report.uptime['90d'])}
      </div>

      <!-- SLA Compliance -->
      ${buildSLASection(siteConfig, store)}

      <!-- Multi-Region Status -->
      ${buildRegionSection(data, report.url)}

      <!-- Response time -->
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;color:#888;">Response Time</span>
          <span style="font-size:13px;color:#333;font-weight:600;">${report.lastLatency ? report.lastLatency + 'ms' : '—'}</span>
        </div>
        ${buildResponseTimeChart(report.responseTimeHistory)}
      </div>

      <!-- Avg latency -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0;padding:12px;background:#fafafa;border-radius:8px;">
        <div style="text-align:center;"><div style="font-size:11px;color:#888;">Avg 24h</div><div style="font-size:16px;font-weight:700;color:#333;">${report.avgLatency['24h'] ? report.avgLatency['24h'] + 'ms' : '—'}</div></div>
        <div style="text-align:center;"><div style="font-size:11px;color:#888;">Avg 7d</div><div style="font-size:16px;font-weight:700;color:#333;">${report.avgLatency['7d'] ? report.avgLatency['7d'] + 'ms' : '—'}</div></div>
        <div style="text-align:center;"><div style="font-size:11px;color:#888;">Avg 30d</div><div style="font-size:16px;font-weight:700;color:#333;">${report.avgLatency['30d'] ? report.avgLatency['30d'] + 'ms' : '—'}</div></div>
      </div>

      <!-- Analytics -->
      ${buildAnalyticsSection(store)}

      ${incidentTable}
    </div>`;
}

function generateStatusPage() {
  const data = loadData();
  const reports = getAllReports(data);
  const config = getConfig();
  const now = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const allUp = reports.every(r => r.currentStatus === 'up');
  const anyDown = reports.some(r => r.currentStatus === 'down');
  const overallStatus = reports.length === 0 ? 'No sites configured' : allUp ? 'All Systems Operational' : anyDown ? 'Partial Outage' : 'Checking...';
  const overallColor = allUp ? '#2e7d32' : anyDown ? '#d32f2f' : '#9e9e9e';
  const overallBg = allUp ? '#edf7ed' : anyDown ? '#fdecea' : '#f5f5f5';

  // Match reports to site configs
  const siteCards = reports.map(report => {
    const siteConfig = (config.sites || []).find(s => s.url === report.url) || {};
    return buildSiteCard(report, data, siteConfig);
  }).join('');

  const totalIncidents = reports.reduce((sum, r) => sum + r.totalIncidents, 0);
  const totalChecks = reports.reduce((sum, r) => sum + r.totalChecks, 0);

  // IP block summary
  let ipBlockBanner = '';
  for (const report of reports) {
    const regionCheck = getLatestRegionCheck(data, report.url);
    if (regionCheck?.ipBlockAnalysis?.blocked) {
      ipBlockBanner += `<div style="background:#fdecea;border:1px solid #d32f2f33;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:13px;color:#d32f2f;font-weight:600;">🚫 ${report.name}: IP/Geo block detected — ${regionCheck.ipBlockAnalysis.analysis}</div>`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>Site Status — Kilowott</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Roboto, Arial, sans-serif; background: #f4f5f7; color: #333; min-height: 100vh; }
    a { color: #1976d2; }
  </style>
</head>
<body>
  <div style="max-width:780px;margin:0 auto;padding:32px 16px;">
    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:26px;font-weight:700;color:#222;margin-bottom:4px;">Site Status</h1>
      <p style="font-size:13px;color:#999;">Kilowott Engineering &middot; Updated ${now}</p>
      <p style="font-size:11px;color:#bbb;margin-top:4px;">Auto-refreshes every 5 minutes</p>
    </div>

    <!-- Overall status banner -->
    <div style="background:${overallBg};border:1px solid ${overallColor}33;border-radius:10px;padding:18px 24px;text-align:center;margin-bottom:24px;">
      <span style="font-size:18px;font-weight:700;color:${overallColor};">${overallStatus}</span>
    </div>

    <!-- IP block alerts -->
    ${ipBlockBanner}

    <!-- Summary stats -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
      <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#222;">${reports.length}</div>
        <div style="font-size:12px;color:#888;">Sites</div>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#222;">${totalChecks.toLocaleString()}</div>
        <div style="font-size:12px;color:#888;">Total Checks</div>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:${totalIncidents > 0 ? '#d32f2f' : '#222'};">${totalIncidents}</div>
        <div style="font-size:12px;color:#888;">Incidents</div>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#222;">${Object.keys(config.teams || {}).length}</div>
        <div style="font-size:12px;color:#888;">Teams</div>
      </div>
    </div>

    <!-- Site cards -->
    ${siteCards}

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;padding:16px;font-size:11px;color:#bbb;">
      Powered by Site Monitor &middot; Kilowott Engineering<br>
      Checks run every 5 minutes via GitHub Actions
    </div>
  </div>
</body>
</html>`;

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), html, 'utf8');
  console.log(`[status-page] Generated ${path.join(OUTPUT_DIR, 'index.html')}`);
}

if (require.main === module) {
  generateStatusPage();
} else {
  module.exports = { generateStatusPage };
}

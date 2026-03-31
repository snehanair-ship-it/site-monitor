/**
 * SLA tracking and reporting.
 *
 * Calculates SLA compliance per site, generates monthly SLA reports,
 * and tracks SLA breach warnings.
 */

const { loadConfig, getTeamForSite, getAllTeams, getSitesForTeam } = require('./config-loader');
const { sendEmail } = require('./alert-router');

const LOG_PREFIX = '[sla-tracker]';

/**
 * Calculate SLA compliance for a site over a given period.
 */
function calculateSLA(store, hoursBack) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = store.checks.filter(c => new Date(c.timestamp).getTime() >= cutoff);
  if (relevant.length === 0) return null;

  const up = relevant.filter(c => c.success).length;
  return {
    uptimePercent: (up / relevant.length) * 100,
    totalChecks: relevant.length,
    successfulChecks: up,
    failedChecks: relevant.length - up,
    periodHours: hoursBack,
  };
}

/**
 * Check if a site is at risk of breaching its SLA target this month.
 */
function checkSLARisk(store, slaTarget) {
  // Calculate current month's SLA
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const relevant = store.checks.filter(c => new Date(c.timestamp).getTime() >= monthStart);

  if (relevant.length < 10) return { atRisk: false, reason: 'Insufficient data' };

  const up = relevant.filter(c => c.success).length;
  const currentSLA = (up / relevant.length) * 100;

  // Calculate remaining budget
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysPassed = now.getDate() + (now.getHours() / 24);
  const daysRemaining = daysInMonth - daysPassed;
  const checksPerDay = relevant.length / daysPassed;
  const estimatedRemainingChecks = Math.round(checksPerDay * daysRemaining);
  const totalEstimatedChecks = relevant.length + estimatedRemainingChecks;

  // How many more failures can we afford?
  const maxAllowedFailures = Math.floor(totalEstimatedChecks * (1 - slaTarget / 100));
  const currentFailures = relevant.length - up;
  const remainingBudget = maxAllowedFailures - currentFailures;

  const atRisk = remainingBudget <= 0 || currentSLA < slaTarget;
  const breached = currentSLA < slaTarget && relevant.length >= 100;

  return {
    atRisk,
    breached,
    currentSLA,
    slaTarget,
    currentFailures,
    maxAllowedFailures,
    remainingBudget: Math.max(0, remainingBudget),
    daysRemaining: Math.round(daysRemaining),
    totalChecks: relevant.length,
    reason: breached
      ? `SLA breached: ${currentSLA.toFixed(2)}% < ${slaTarget}% target`
      : atRisk
        ? `At risk: only ${remainingBudget} failures remaining in budget`
        : `On track: ${remainingBudget} failures remaining in budget`,
  };
}

/**
 * Generate a monthly SLA report for all teams.
 */
async function generateMonthlySLAReport(data) {
  const config = loadConfig();
  const allTeams = getAllTeams();

  for (const [teamId, team] of Object.entries(allTeams)) {
    const teamSites = getSitesForTeam(teamId);
    if (!teamSites.length) continue;

    const siteRows = teamSites.map(siteConfig => {
      const store = data.sites[siteConfig.url];
      if (!store) return null;

      const sla30d = calculateSLA(store, 24 * 30);
      const slaTarget = siteConfig.sla_target || config.global?.default_sla_target || 99.9;
      const risk = checkSLARisk(store, slaTarget);

      const uptimeStr = sla30d ? sla30d.uptimePercent.toFixed(3) + '%' : 'N/A';
      const met = sla30d && sla30d.uptimePercent >= slaTarget;
      const statusColor = met ? '#2e7d32' : '#d32f2f';
      const statusText = met ? 'MET' : 'BREACHED';

      // Count incidents this month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthIncidents = (store.incidents || []).filter(
        i => new Date(i.startedAt).getTime() >= monthStart.getTime()
      ).length;

      // Total downtime this month
      const monthDowntimeMs = (store.incidents || [])
        .filter(i => new Date(i.startedAt).getTime() >= monthStart.getTime() && i.durationMs)
        .reduce((sum, i) => sum + i.durationMs, 0);
      const downtimeStr = formatDuration(monthDowntimeMs);

      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">${siteConfig.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:700;color:${statusColor};">${uptimeStr}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">${slaTarget}%</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;color:${statusColor};font-weight:600;">${statusText}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">${monthIncidents}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">${downtimeStr}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;">${risk.remainingBudget} checks</td>
      </tr>`;
    }).filter(Boolean).join('');

    if (!siteRows) continue;

    const now = new Date();
    const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const emails = team.members.map(m => m.email);

    const html = `
    <div style="font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:720px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
      <div style="background:#7b1fa2;padding:20px 24px;">
        <h1 style="margin:0;color:#fff;font-size:20px;">Monthly SLA Report</h1>
        <p style="margin:4px 0 0;color:#e1bee7;font-size:13px;">${team.name} — ${monthName}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">SITE</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">UPTIME</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">TARGET</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">STATUS</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">INCIDENTS</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">DOWNTIME</th>
            <th style="padding:8px 12px;text-align:left;color:#888;font-size:11px;">BUDGET LEFT</th>
          </tr></thead>
          <tbody>${siteRows}</tbody>
        </table>
        <p style="font-size:11px;color:#999;margin:20px 0 0;text-align:center;">Generated by Site Monitor — Kilowott Engineering</p>
      </div>
    </div>`;

    await sendEmail(emails, `Monthly SLA Report — ${team.name} — ${monthName}`, `SLA Report for ${team.name}`, html);
    console.log(`${LOG_PREFIX} Monthly SLA report sent to ${team.name}`);
  }
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

module.exports = {
  calculateSLA,
  checkSLARisk,
  generateMonthlySLAReport,
};

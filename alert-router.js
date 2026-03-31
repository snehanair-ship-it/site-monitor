/**
 * Team-based alert routing with escalation policies and Slack integration.
 *
 * Routes alerts to the owning team, supports escalation levels based on
 * incident duration, and sends to Slack webhooks when configured.
 */

const nodemailer = require('nodemailer');
const fetch = globalThis.fetch || require('node-fetch');
const { getTeamForSite, getAllTeams, getGlobal } = require('./config-loader');

const LOG_PREFIX = '[alert-router]';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

/**
 * Determine which escalation level we're at based on incident duration.
 */
function getEscalationLevel(incidentStartedAt, escalationPolicy) {
  if (!incidentStartedAt || !escalationPolicy) return 1;

  const durationMin = (Date.now() - new Date(incidentStartedAt).getTime()) / 60000;

  if (escalationPolicy.level_3_after_minutes != null && durationMin >= escalationPolicy.level_3_after_minutes) {
    return 3;
  }
  if (escalationPolicy.level_2_after_minutes != null && durationMin >= escalationPolicy.level_2_after_minutes) {
    return 2;
  }
  return 1;
}

/**
 * Get recipients based on escalation level.
 * Level 1: level 1 members of owning team
 * Level 2: level 1 + level 2 members (tech leads)
 * Level 3: level 1 + level 2 + management team
 */
function getRecipients(site, escalationLevel) {
  const team = getTeamForSite(site);
  if (!team) {
    // Fallback: send to ALERT_TO env
    const fallback = (process.env.ALERT_TO || '').split(',').map(e => e.trim()).filter(Boolean);
    return { emails: fallback, slackWebhook: null, level: 1 };
  }

  const emails = new Set();

  // Add team members up to current escalation level
  for (const member of team.members || []) {
    if (member.escalation_level <= escalationLevel) {
      emails.add(member.email);
    }
  }

  // At level 3, also include management team
  if (escalationLevel >= 3) {
    const allTeams = getAllTeams();
    const mgmt = allTeams.management;
    if (mgmt) {
      for (const member of mgmt.members || []) {
        emails.add(member.email);
      }
    }
  }

  return {
    emails: Array.from(emails),
    slackWebhook: team.slack_webhook || null,
    level: escalationLevel,
    teamName: team.name,
  };
}

/**
 * Send alert email to the appropriate recipients.
 */
async function sendEmail(recipients, subject, text, html) {
  if (!recipients.length) {
    console.warn(`${LOG_PREFIX} No email recipients, skipping.`);
    return;
  }

  const transporter = getTransporter();
  const mail = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: recipients,
    subject,
    text,
    html,
  };

  const result = await transporter.sendMail(mail);
  console.log(`${LOG_PREFIX} Email sent to ${recipients.join(', ')} (${result.messageId})`);
}

/**
 * Send Slack notification via incoming webhook.
 */
async function sendSlack(webhookUrl, payload) {
  if (!webhookUrl) return;

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`${LOG_PREFIX} Slack webhook failed: ${resp.status}`);
    } else {
      console.log(`${LOG_PREFIX} Slack notification sent.`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Slack webhook error:`, err.message);
  }
}

/**
 * Build Slack message payload.
 */
function buildSlackPayload({ siteName, siteUrl, type, severity, details, escalationLevel, teamName }) {
  const colorMap = { CRITICAL: '#d32f2f', WARNING: '#ed6c02', RESOLVED: '#2e7d32', INFO: '#0288d1' };
  const color = colorMap[severity.level] || '#9e9e9e';

  const fields = details.map(d => ({
    title: d.label,
    value: d.value,
    short: true,
  }));

  if (escalationLevel > 1) {
    fields.push({
      title: 'Escalation',
      value: `Level ${escalationLevel}${teamName ? ` — ${teamName}` : ''}`,
      short: true,
    });
  }

  return {
    attachments: [{
      color,
      title: `${severity.icon} [${severity.level}] ${siteName}`,
      title_link: siteUrl,
      fields,
      footer: 'Site Monitor — Kilowott Engineering',
      ts: Math.floor(Date.now() / 1000),
    }],
  };
}

/**
 * Route an alert to the correct team with escalation.
 */
async function routeAlert({ site, subject, text, html, type, severity, details, incidentStartedAt }) {
  const team = getTeamForSite(site);
  const escalationPolicy = team?.escalation || {};
  const escalationLevel = getEscalationLevel(incidentStartedAt, escalationPolicy);

  const { emails, slackWebhook, teamName } = getRecipients(site, escalationLevel);

  const escalatedSubject = escalationLevel > 1
    ? `${subject} [ESCALATION L${escalationLevel}]`
    : subject;

  // Send email
  await sendEmail(emails, escalatedSubject, text, html);

  // Send Slack
  if (slackWebhook) {
    const slackPayload = buildSlackPayload({
      siteName: site.name,
      siteUrl: site.url,
      type,
      severity,
      details: details || [],
      escalationLevel,
      teamName,
    });
    await sendSlack(slackWebhook, slackPayload);
  }

  console.log(`${LOG_PREFIX} Alert routed to ${teamName || 'default'} (L${escalationLevel}): ${emails.join(', ')}`);

  return { emails, escalationLevel, teamName };
}

/**
 * Send weekly digest to all teams.
 */
async function sendWeeklyDigest(reports) {
  const allTeams = getAllTeams();

  for (const [teamId, team] of Object.entries(allTeams)) {
    const teamSiteUrls = new Set(
      (require('./config-loader').getSitesForTeam(teamId)).map(s => s.url)
    );
    const teamReports = reports.filter(r => teamSiteUrls.has(r.url));
    if (!teamReports.length) continue;

    const emails = team.members.map(m => m.email);
    const subject = `Weekly Status Digest — ${team.name}`;

    const rows = teamReports.map(r => {
      const u24 = r.uptime['24h'] != null ? r.uptime['24h'].toFixed(2) + '%' : 'N/A';
      const u7d = r.uptime['7d'] != null ? r.uptime['7d'].toFixed(2) + '%' : 'N/A';
      const latency = r.avgLatency['7d'] != null ? r.avgLatency['7d'] + 'ms' : 'N/A';
      const incidents = r.totalIncidents || 0;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${r.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${u24}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${u7d}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${latency}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">${incidents}</td>
      </tr>`;
    }).join('');

    const html = `
    <div style="font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
      <div style="background:#1976d2;padding:20px 24px;">
        <h1 style="margin:0;color:#fff;font-size:20px;">Weekly Status Digest</h1>
        <p style="margin:4px 0 0;color:#bbdefb;font-size:13px;">${team.name} — ${new Date().toLocaleDateString('en-US', { dateStyle: 'medium' })}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">Site</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">24h</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">7d</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">Avg Latency</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#888;">Incidents</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:11px;color:#999;margin:20px 0 0;text-align:center;">Sent by Site Monitor — Kilowott Engineering</p>
      </div>
    </div>`;

    await sendEmail(emails, subject, `Weekly digest for ${team.name}`, html);
  }
}

module.exports = {
  routeAlert,
  sendEmail,
  sendSlack,
  getEscalationLevel,
  getRecipients,
  sendWeeklyDigest,
};

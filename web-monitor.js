#!/usr/bin/env node

/**
 * Organisation-wide site monitor with:
 * - Uptime monitoring with persistent history
 * - Multi-region checks and IP block detection
 * - Team-based alert routing with escalation
 * - Core Web Vitals tracking
 * - SLA tracking and monthly reports
 * - Historical analytics and trend analysis
 * - Authentication-aware endpoint checks
 * - Status page dashboard (GitHub Pages)
 *
 * Usage:
 *   node web-monitor.js             # continuous mode (cron)
 *   node web-monitor.js --once      # single check cycle (CI)
 *   node web-monitor.js --report    # generate SLA report
 *   node web-monitor.js --digest    # send weekly digest
 */

require('dotenv').config();
const fetch = globalThis.fetch || require('node-fetch');
const cron = require('node-cron');

// Modules
const { loadConfig, getAuthHeaders, getThresholds, getGlobal, getIPBlockConfig } = require('./config-loader');
const uptimeStore = require('./uptime-store');
const { generateStatusPage } = require('./status-page');
const { routeAlert, sendWeeklyDigest } = require('./alert-router');
const { multiRegionCheck } = require('./multi-region');
const { checkSLARisk, generateMonthlySLAReport } = require('./sla-tracker');
const { generateSiteAnalytics } = require('./analytics');
const aiops = require('./aiops');

const LOG_PREFIX = '[site-monitor]';

// Load config
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`${LOG_PREFIX} Failed to load config:`, err.message);
  process.exit(1);
}

const globalConfig = getGlobal();
const thresholds = getThresholds();
const sites = config.sites || [];
const WATCH_INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || globalConfig.check_interval_minutes || 5);
const VITALS_INTERVAL_MINUTES = Number(process.env.VITALS_MINUTES || globalConfig.vitals_interval_minutes || 30);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || globalConfig.timeout_ms || 20000);

if (!sites.length) {
  console.error(`${LOG_PREFIX} No sites configured in config.yml.`);
  process.exit(1);
}

// Validate email config
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn(`${LOG_PREFIX} SMTP not fully configured. Email alerts will be skipped.`);
}

const state = {};

function now() {
  return new Date().toISOString();
}

// -------------------------------------------------------------------------
// Availability check (with auth support)
// -------------------------------------------------------------------------
async function fetchWithTimeout(url, ms, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const start = Date.now();
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers,
    });
    const latency = Date.now() - start;
    return { ok: res.ok, status: res.status, statusText: res.statusText, latency, headers: res.headers };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAvailability(site) {
  const authHeaders = getAuthHeaders(site);
  const endpoints = site.check_endpoints || [{ path: '/', method: 'GET', expected_status: 200 }];

  // Check all configured endpoints
  const results = [];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint.path, site.url).href;
    try {
      const checked = await fetchWithTimeout(url, TIMEOUT_MS, authHeaders);
      const expectedStatus = endpoint.expected_status || 200;
      const success = checked.ok && checked.status < 500 &&
        (expectedStatus ? checked.status === expectedStatus : true);
      results.push({ endpoint: endpoint.path, success, detail: checked });
    } catch (err) {
      results.push({ endpoint: endpoint.path, success: false, error: err?.message || String(err) });
    }
  }

  // Site is up if primary endpoint (first) is successful
  const primary = results[0];
  return {
    success: primary.success,
    detail: primary.detail,
    error: primary.error,
    endpoints: results,
  };
}

// -------------------------------------------------------------------------
// Core Web Vitals
// -------------------------------------------------------------------------
async function fetchCoreWebVitals(site) {
  const apiKey = process.env.PSI_API_KEY || '';
  const params = new URLSearchParams({ url: site.url, strategy: process.env.PSI_STRATEGY || 'mobile' });
  if (apiKey) params.append('key', apiKey);
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const resp = await fetch(endpoint, { timeout: 25000 });
  if (!resp.ok) throw new Error(`PageSpeed API failed with status ${resp.status}`);

  const payload = await resp.json();
  const audits = payload?.lighthouseResult?.audits;
  if (!audits) throw new Error('PageSpeed API response missing lighthouseResult.audits');

  return {
    LCP: audits['largest-contentful-paint']?.numericValue || null,
    FCP: audits['first-contentful-paint']?.numericValue || null,
    CLS: audits['cumulative-layout-shift']?.numericValue || null,
    TBT: audits['total-blocking-time']?.numericValue || null,
    performanceScore: payload?.lighthouseResult?.categories?.performance?.score || null,
  };
}

function isVitalsBad(vitals) {
  if (!vitals) return false;
  return (
    (typeof vitals.LCP === 'number' && vitals.LCP > thresholds.LCP) ||
    (typeof vitals.FCP === 'number' && vitals.FCP > thresholds.FCP) ||
    (typeof vitals.CLS === 'number' && vitals.CLS > thresholds.CLS) ||
    (typeof vitals.TBT === 'number' && vitals.TBT > thresholds.TBT)
  );
}

// -------------------------------------------------------------------------
// Severity & recommendations (for email HTML)
// -------------------------------------------------------------------------
function getSeverity(type, detail) {
  if (type === 'down') return { level: 'CRITICAL', color: '#d32f2f', bg: '#fdecea', icon: '🔴' };
  if (type === 'ip_block') return { level: 'CRITICAL', color: '#d32f2f', bg: '#fdecea', icon: '🚫' };
  if (type === 'vitals') {
    const scores = [];
    if (detail.LCP > thresholds.LCP * 1.5) scores.push('LCP');
    if (detail.FCP > thresholds.FCP * 1.5) scores.push('FCP');
    if (detail.CLS > thresholds.CLS * 2) scores.push('CLS');
    if (detail.TBT > thresholds.TBT * 1.5) scores.push('TBT');
    if (scores.length >= 2) return { level: 'CRITICAL', color: '#d32f2f', bg: '#fdecea', icon: '🔴' };
    return { level: 'WARNING', color: '#ed6c02', bg: '#fff4e5', icon: '🟡' };
  }
  if (type === 'sla_risk') return { level: 'WARNING', color: '#ed6c02', bg: '#fff4e5', icon: '⚠️' };
  if (type === 'recovery') return { level: 'RESOLVED', color: '#2e7d32', bg: '#edf7ed', icon: '🟢' };
  if (type === 'trend') return { level: 'INFO', color: '#0288d1', bg: '#e5f6fd', icon: '📊' };
  return { level: 'INFO', color: '#0288d1', bg: '#e5f6fd', icon: '🔵' };
}

function getRecommendations(type, detail) {
  const recs = [];
  if (type === 'down') {
    recs.push('Verify the server/hosting is running and accessible.');
    recs.push('Check DNS resolution and SSL certificate validity.');
    recs.push('Review recent deployments for breaking changes — consider a rollback if needed.');
    recs.push('Inspect server logs for errors (e.g. 502, 503, connection refused).');
    recs.push('Confirm CDN or reverse proxy (e.g. Cloudflare, Nginx) is routing correctly.');
    recs.push('If the issue persists beyond 10 minutes, escalate to the hosting provider.');
  }
  if (type === 'ip_block') {
    recs.push('Site is reachable from some regions but blocked from others — possible IP/geo-restriction.');
    recs.push('Check firewall rules, WAF settings (Cloudflare, AWS WAF), and rate-limiting policies.');
    recs.push('Verify no recent IP bans were applied that affect legitimate traffic.');
    recs.push('Check if the hosting provider or CDN is blocking specific country/region IPs.');
    recs.push('Review server access logs for 403/429 patterns from affected regions.');
  }
  if (type === 'vitals') {
    if (detail.LCP && detail.LCP > thresholds.LCP) {
      recs.push(`LCP is ${Math.round(detail.LCP)}ms (threshold: ${thresholds.LCP}ms) — optimize largest visible element: compress hero images, use next-gen formats (WebP/AVIF), defer non-critical resources.`);
    }
    if (detail.FCP && detail.FCP > thresholds.FCP) {
      recs.push(`FCP is ${Math.round(detail.FCP)}ms (threshold: ${thresholds.FCP}ms) — reduce render-blocking CSS/JS, inline critical CSS, enable server-side caching.`);
    }
    if (detail.CLS && detail.CLS > thresholds.CLS) {
      recs.push(`CLS is ${detail.CLS.toFixed(3)} (threshold: ${thresholds.CLS}) — set explicit dimensions on images/ads/embeds, avoid injecting content above the fold.`);
    }
    if (detail.TBT && detail.TBT > thresholds.TBT) {
      recs.push(`TBT is ${Math.round(detail.TBT)}ms (threshold: ${thresholds.TBT}ms) — break up long JS tasks, defer/lazy-load heavy scripts, reduce third-party script impact.`);
    }
    if (detail.performanceScore !== null && detail.performanceScore < 0.5) {
      recs.push('Overall performance score is below 50 — a full Lighthouse audit and performance sprint is recommended.');
    }
  }
  if (type === 'sla_risk') {
    recs.push('SLA target is at risk of being breached this month.');
    recs.push('Review recent incidents and address root causes immediately.');
    recs.push('Consider scaling infrastructure or enabling redundancy.');
  }
  return recs;
}

function buildHtmlEmail({ siteName, siteUrl, severity, timestamp, details, recommendations }) {
  const statusBadge = `<span style="display:inline-block;padding:4px 12px;border-radius:4px;background:${severity.bg};color:${severity.color};font-weight:bold;font-size:14px;border:1px solid ${severity.color};">${severity.icon} ${severity.level}</span>`;

  const detailRows = details.map(d =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;width:180px;">${d.label}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:${d.highlight ? severity.color : '#333'};">${d.highlight ? '<strong>' + d.value + '</strong>' : d.value}</td></tr>`
  ).join('');

  const recItems = recommendations.map(r =>
    `<li style="margin-bottom:6px;color:#333;">${r}</li>`
  ).join('');

  return `
  <div style="font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
    <div style="background:${severity.color};padding:20px 24px;">
      <h1 style="margin:0;color:#fff;font-size:20px;">Site Monitor Alert</h1>
    </div>
    <div style="padding:24px;">
      <div style="margin-bottom:16px;">
        ${statusBadge}
        <span style="margin-left:12px;font-size:16px;color:#333;font-weight:600;">${siteName}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fafafa;border-radius:6px;overflow:hidden;">
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;width:180px;">Site</td><td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="${siteUrl}" style="color:#1976d2;">${siteUrl}</a></td></tr>
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;">Timestamp</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${timestamp}</td></tr>
        ${detailRows}
      </table>
      ${recommendations.length > 0 ? `
      <div style="background:#f5f5f5;border-left:4px solid ${severity.color};padding:16px;border-radius:4px;margin-bottom:16px;">
        <h3 style="margin:0 0 10px;color:${severity.color};font-size:14px;">💡 Tech Lead Recommendations</h3>
        <ol style="margin:0;padding-left:20px;font-size:13px;">${recItems}</ol>
      </div>` : ''}
      <p style="font-size:11px;color:#999;margin:16px 0 0;text-align:center;">Sent by Site Monitor · Kilowott Engineering</p>
    </div>
  </div>`;
}

// -------------------------------------------------------------------------
// Unified alert sender (routes to team + builds HTML)
// -------------------------------------------------------------------------
async function sendAlert(subject, text, { type = 'info', site = {}, vitals = null, extraDetails = [] } = {}) {
  const severity = getSeverity(type, vitals || {});
  const timestamp = now();

  const details = [...extraDetails];
  if (type === 'down') {
    details.push({ label: 'Status', value: 'UNREACHABLE / DOWN', highlight: true });
    details.push({ label: 'Error', value: text, highlight: false });
  } else if (type === 'vitals' && vitals) {
    details.push({ label: 'Performance Score', value: vitals.performanceScore !== null ? Math.round(vitals.performanceScore * 100) + '/100' : 'N/A', highlight: vitals.performanceScore !== null && vitals.performanceScore < 0.5 });
    details.push({ label: 'LCP', value: `${Math.round(vitals.LCP)}ms`, highlight: vitals.LCP > thresholds.LCP });
    details.push({ label: 'FCP', value: `${Math.round(vitals.FCP)}ms`, highlight: vitals.FCP > thresholds.FCP });
    details.push({ label: 'CLS', value: vitals.CLS.toFixed(3), highlight: vitals.CLS > thresholds.CLS });
    details.push({ label: 'TBT', value: `${Math.round(vitals.TBT)}ms`, highlight: vitals.TBT > thresholds.TBT });
  } else if (type === 'recovery') {
    details.push({ label: 'Status', value: 'BACK ONLINE', highlight: false });
  }

  const recommendations = getRecommendations(type, vitals || {});

  const html = buildHtmlEmail({
    siteName: site.name || 'Unknown',
    siteUrl: site.url || '',
    severity,
    timestamp,
    details,
    recommendations,
  });

  // Get incident start time for escalation calculation
  const data = uptimeStore.loadData();
  const siteStore = data.sites?.[site.url];
  const incidentStartedAt = siteStore?.currentIncident?.startedAt || null;

  try {
    await routeAlert({
      site,
      subject: `${severity.icon} [${severity.level}] ${subject}`,
      text,
      html,
      type,
      severity,
      details,
      incidentStartedAt,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Alert routing failed:`, err.message);
    // Fallback: log the alert
    console.error(`${LOG_PREFIX} ALERT: ${subject} — ${text}`);
  }
}

// -------------------------------------------------------------------------
// Main monitor cycle
// -------------------------------------------------------------------------
async function monitorCycle() {
  console.log(`${LOG_PREFIX} Starting check cycle at ${now()}`);
  const data = uptimeStore.loadData();
  const ipBlockConfig = getIPBlockConfig();

  await Promise.all(sites.map(async site => {
    const currentState = state[site.url] = state[site.url] || { downCount: 0, lastVitals: null, lastRegionCheck: 0 };

    // --- Availability check (with auth) ---
    const availability = await checkAvailability(site);
    uptimeStore.recordCheck(data, site, availability);

    if (!availability.success) {
      currentState.downCount += 1;
      console.warn(`${LOG_PREFIX} ${site.name} DOWN (#${currentState.downCount}):`, availability.error || availability.detail?.status);

      const repeatEvery = Number(process.env.REPEAT_ALERT_EVERY || globalConfig.repeat_alert_every || 3);
      if (currentState.downCount === 1 || currentState.downCount % repeatEvery === 0) {
        await sendAlert(
          `${site.name} (${site.url}) is DOWN`,
          `${site.name} is down at ${now()}\nError: ${availability.error || availability.detail?.statusText}`,
          { type: 'down', site }
        );
      }
    } else {
      // Site is reachable
      if (currentState.downCount > 0) {
        await sendAlert(
          `${site.name} back online`,
          `${site.name} is back up at ${now()} (status ${availability.detail.status})`,
          { type: 'recovery', site }
        );
      }
      currentState.downCount = 0;
      console.info(`${LOG_PREFIX} ${site.name} UP (${availability.detail.status}) latency=${availability.detail.latency}ms`);
    }

    // --- Multi-region / IP block detection ---
    if (ipBlockConfig.enabled) {
      const regionCheckAge = (Date.now() - currentState.lastRegionCheck) / 60000;
      // Run region check every 30 minutes or on first run
      if (regionCheckAge >= 30 || currentState.lastRegionCheck === 0) {
        try {
          console.log(`${LOG_PREFIX} ${site.name} Running multi-region check...`);
          const regionResult = await multiRegionCheck(site, TIMEOUT_MS);
          uptimeStore.recordRegionCheck(data, site, regionResult);
          currentState.lastRegionCheck = Date.now();

          if (regionResult.ipBlockAnalysis.blocked || regionResult.ipBlockAnalysis.partialBlock) {
            const analysis = regionResult.ipBlockAnalysis;
            console.warn(`${LOG_PREFIX} ${site.name} IP BLOCK DETECTED:`, analysis.analysis);

            await sendAlert(
              `${site.name} — IP/Geo Block Detected`,
              analysis.analysis,
              {
                type: 'ip_block',
                site,
                extraDetails: [
                  { label: 'Reachability', value: `${analysis.reachableCount}/${analysis.totalNodes} regions`, highlight: true },
                  { label: 'Analysis', value: analysis.analysis, highlight: false },
                  { label: 'Runner IP', value: regionResult.runnerIP || 'Unknown', highlight: false },
                ],
              }
            );
          } else {
            console.log(`${LOG_PREFIX} ${site.name} Reachable from all regions.`);
          }
        } catch (err) {
          console.error(`${LOG_PREFIX} ${site.name} Multi-region check failed:`, err.message);
        }
      }
    }

    // --- Core Web Vitals ---
    if (site.vitals_enabled !== false && availability.success) {
      const lastVitals = currentState.lastVitals || { when: 0 };
      const ageMin = (Date.now() - lastVitals.when) / 60000;

      if (ageMin >= VITALS_INTERVAL_MINUTES) {
        try {
          const vitals = await fetchCoreWebVitals(site);
          currentState.lastVitals = { when: Date.now(), vitals };
          uptimeStore.recordVitals(data, site, vitals);

          if (isVitalsBad(vitals)) {
            console.warn(`${LOG_PREFIX} ${site.name} bad CWV`, vitals);
            await sendAlert(
              `${site.name} Core Web Vitals degraded`,
              `${site.name} core web vitals cross threshold at ${now()}\nLCP=${vitals.LCP}ms, FCP=${vitals.FCP}ms, CLS=${vitals.CLS}, TBT=${vitals.TBT}, score=${vitals.performanceScore}`,
              { type: 'vitals', site, vitals }
            );
          } else {
            console.log(`${LOG_PREFIX} ${site.name} CWV nominal`, vitals);
          }
        } catch (err) {
          console.error(`${LOG_PREFIX} ${site.name} CWV check failed:`, err.message || err);
        }
      }
    }

    // --- SLA risk check ---
    const siteStore = data.sites?.[site.url];
    if (siteStore) {
      const slaTarget = site.sla_target || globalConfig.default_sla_target || 99.9;
      const risk = checkSLARisk(siteStore, slaTarget);
      if (risk.atRisk && !currentState.slaWarned) {
        currentState.slaWarned = true;
        await sendAlert(
          `${site.name} — SLA at risk (${risk.currentSLA?.toFixed(2)}% vs ${slaTarget}% target)`,
          risk.reason,
          {
            type: 'sla_risk',
            site,
            extraDetails: [
              { label: 'Current SLA', value: `${risk.currentSLA?.toFixed(2)}%`, highlight: true },
              { label: 'Target', value: `${slaTarget}%`, highlight: false },
              { label: 'Failure Budget', value: `${risk.remainingBudget} checks remaining`, highlight: risk.remainingBudget <= 0 },
              { label: 'Days Left', value: `${risk.daysRemaining} days`, highlight: false },
            ],
          }
        );
      } else if (!risk.atRisk) {
        currentState.slaWarned = false;
      }

      // --- Analytics: trend warnings ---
      const analytics = generateSiteAnalytics(siteStore);
      if (analytics.latencyTrend.trend === 'degrading' && !currentState.trendWarned) {
        currentState.trendWarned = true;
        await sendAlert(
          `${site.name} — Response time degrading`,
          analytics.latencyTrend.message,
          {
            type: 'trend',
            site,
            extraDetails: [
              { label: 'Trend', value: analytics.latencyTrend.message, highlight: true },
              { label: 'Change', value: `+${analytics.latencyTrend.change?.toFixed(0)}%`, highlight: true },
            ],
          }
        );
      } else if (analytics.latencyTrend.trend !== 'degrading') {
        currentState.trendWarned = false;
      }
    }
  }));

  // --- AIOps analysis ---
  try {
    console.log(`${LOG_PREFIX} Running AIOps analysis...`);
    const aiopsResult = await aiops.analyzeAll(data, sites);
    data._aiops = aiopsResult;

    // Send alerts for AIOps critical findings
    for (const alert of aiopsResult.criticalAlerts || []) {
      if (alert.severity === 'critical' && alert.site) {
        const site = sites.find(s => s.name === alert.site || s.url === alert.url);
        if (site && !state[site.url]?.aiopsAlerted?.[alert.type]) {
          state[site.url] = state[site.url] || {};
          state[site.url].aiopsAlerted = state[site.url].aiopsAlerted || {};
          state[site.url].aiopsAlerted[alert.type] = true;

          await sendAlert(
            `${alert.site} — AIOps: ${alert.message}`,
            `AIOps detected: ${alert.message}`,
            {
              type: alert.type === 'sla_breach' ? 'sla_risk' : 'trend',
              site,
              extraDetails: [
                { label: 'AIOps Alert', value: alert.message, highlight: true },
                { label: 'Type', value: alert.type, highlight: false },
              ],
            }
          );
        }
      }
    }

    // Root cause analysis alert
    if (aiopsResult.rootCauseAnalysis.severity === 'critical') {
      const rca = aiopsResult.rootCauseAnalysis;
      console.warn(`${LOG_PREFIX} RCA: ${rca.hypothesis}`);
      // Alert first affected site's team
      const firstSite = sites[0];
      if (firstSite && !state._rcaAlerted) {
        state._rcaAlerted = true;
        await sendAlert(
          `Root Cause Analysis — ${rca.hypothesis}`,
          `AIOps RCA:\n${rca.hypothesis}\n\nFindings:\n${rca.findings.map(f => `- ${f.finding}`).join('\n')}`,
          {
            type: 'down',
            site: firstSite,
            extraDetails: [
              { label: 'Hypothesis', value: rca.hypothesis, highlight: true },
              ...rca.findings.map(f => ({ label: f.type, value: f.finding, highlight: f.severity === 'critical' })),
            ],
          }
        );
      }
    } else {
      state._rcaAlerted = false;
    }

    console.log(`${LOG_PREFIX} AIOps: ${aiopsResult.summary.overallHealth} (${aiopsResult.summary.totalAlerts} alerts)`);
  } catch (err) {
    console.error(`${LOG_PREFIX} AIOps analysis failed:`, err.message);
  }

  // Save data and generate status page
  uptimeStore.saveData(data);
  generateStatusPage();
  console.log(`${LOG_PREFIX} Check cycle completed at ${now()}`);
}

// -------------------------------------------------------------------------
// CLI modes
// -------------------------------------------------------------------------
const runOnce = process.argv.includes('--once');
const runReport = process.argv.includes('--report');
const runDigest = process.argv.includes('--digest');

if (runReport) {
  console.log(`${LOG_PREFIX} Generating monthly SLA report...`);
  const data = uptimeStore.loadData();
  generateMonthlySLAReport(data)
    .then(() => { console.log(`${LOG_PREFIX} Report sent.`); process.exit(0); })
    .catch(err => { console.error(`${LOG_PREFIX} Report error:`, err); process.exit(1); });
} else if (runDigest) {
  console.log(`${LOG_PREFIX} Sending weekly digest...`);
  const data = uptimeStore.loadData();
  const reports = uptimeStore.getAllReports(data);
  sendWeeklyDigest(reports)
    .then(() => { console.log(`${LOG_PREFIX} Digest sent.`); process.exit(0); })
    .catch(err => { console.error(`${LOG_PREFIX} Digest error:`, err); process.exit(1); });
} else if (runOnce) {
  console.log(`${LOG_PREFIX} Running single check for ${sites.length} site(s)...`);
  monitorCycle()
    .then(() => { console.log(`${LOG_PREFIX} Done.`); process.exit(0); })
    .catch(err => { console.error(`${LOG_PREFIX} Error:`, err); process.exit(1); });
} else {
  console.log(`${LOG_PREFIX} Monitoring ${sites.length} site(s) every ${WATCH_INTERVAL_MINUTES} minutes.`);
  cron.schedule(`*/${WATCH_INTERVAL_MINUTES} * * * *`, () => {
    monitorCycle().catch(err => console.error(`${LOG_PREFIX} Cycle error:`, err));
  });
  // first immediate run
  monitorCycle().catch(err => console.error(`${LOG_PREFIX} Initial run error:`, err));
}

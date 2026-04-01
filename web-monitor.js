#!/usr/bin/env node

/**
 * Uptime monitor — checks sites, records up/down with timestamps,
 * tracks incident duration, sends email alerts.
 *
 * Usage:
 *   node web-monitor.js             # continuous mode (cron)
 *   node web-monitor.js --once      # single check (CI)
 */

require('dotenv').config();
const fetch = globalThis.fetch || require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { loadConfig, getGlobal } = require('./config-loader');
const uptimeStore = require('./uptime-store');

const LOG_PREFIX = '[monitor]';

// Load config
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`${LOG_PREFIX} Config error:`, err.message);
  process.exit(1);
}

const globalConfig = getGlobal();
const sites = config.sites || [];
const INTERVAL = Number(process.env.INTERVAL_MINUTES || globalConfig.check_interval_minutes || 5);
const TIMEOUT = Number(process.env.TIMEOUT_MS || globalConfig.timeout_ms || 20000);
const REPEAT_ALERT = Number(process.env.REPEAT_ALERT_EVERY || globalConfig.repeat_alert_every || 3);

if (!sites.length) {
  console.log(`${LOG_PREFIX} No sites configured.`);
  process.exit(0);
}

// Email setup
let transporter = null;
const smtpReady = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
if (smtpReady) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const globalAlertTo = (process.env.ALERT_TO || '').split(',').map(e => e.trim()).filter(Boolean);

const state = {};

function now() { return new Date().toISOString(); }

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── HTTP check ──
async function checkSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latency = Date.now() - start;
    return { success: res.ok && res.status < 500, detail: { status: res.status, statusText: res.statusText, latency } };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Email alert ──
function getAlertEmails(site) {
  // Per-site emails take priority, fall back to global ALERT_TO
  const siteEmails = (site.alert_emails || []).filter(e => e && e.includes('@'));
  return siteEmails.length > 0 ? siteEmails : globalAlertTo;
}

async function sendAlert(subject, html, site) {
  if (!transporter) return;
  const recipients = getAlertEmails(site);
  if (!recipients.length) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients,
      subject,
      html,
    });
    console.log(`${LOG_PREFIX} Alert sent to ${recipients.join(', ')}: ${subject}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Email failed:`, err.message);
  }
}

function buildDownEmail(site, error, downSince, downCount) {
  const duration = downSince ? formatDuration(Date.now() - new Date(downSince).getTime()) : '';
  return `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#dc2626;padding:16px 20px;color:#fff;font-size:16px;font-weight:600;">
      Site Down: ${site.name}
    </div>
    <div style="padding:20px;">
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6b7280;">URL</td><td style="padding:6px 0;"><a href="${site.url}">${site.url}</a></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Status</td><td style="padding:6px 0;color:#dc2626;font-weight:600;">DOWN</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Error</td><td style="padding:6px 0;">${error}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Down since</td><td style="padding:6px 0;">${downSince || now()}</td></tr>
        ${duration ? `<tr><td style="padding:6px 0;color:#6b7280;">Duration</td><td style="padding:6px 0;font-weight:600;">${duration}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#6b7280;">Consecutive failures</td><td style="padding:6px 0;">${downCount}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Detected at</td><td style="padding:6px 0;">${now()}</td></tr>
      </table>
    </div>
  </div>`;
}

function buildUpEmail(site, latency, wasDownSince, downDuration) {
  return `
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#16a34a;padding:16px 20px;color:#fff;font-size:16px;font-weight:600;">
      Site Recovered: ${site.name}
    </div>
    <div style="padding:20px;">
      <table style="width:100%;font-size:14px;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6b7280;">URL</td><td style="padding:6px 0;"><a href="${site.url}">${site.url}</a></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Status</td><td style="padding:6px 0;color:#16a34a;font-weight:600;">UP</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Latency</td><td style="padding:6px 0;">${latency}ms</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Was down since</td><td style="padding:6px 0;">${wasDownSince}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Total downtime</td><td style="padding:6px 0;font-weight:600;">${downDuration}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Recovered at</td><td style="padding:6px 0;">${now()}</td></tr>
      </table>
    </div>
  </div>`;
}

// ── Main cycle ──
async function monitorCycle() {
  console.log(`${LOG_PREFIX} Checking ${sites.length} site(s)...`);
  const data = uptimeStore.loadData();

  await Promise.all(sites.map(async site => {
    const s = state[site.url] = state[site.url] || { downCount: 0, downSince: null };
    const result = await checkSite(site.url);

    uptimeStore.recordCheck(data, site, result);

    if (!result.success) {
      s.downCount += 1;
      if (s.downCount === 1) s.downSince = now();

      const error = result.error || `HTTP ${result.detail?.status} ${result.detail?.statusText || ''}`;
      console.warn(`${LOG_PREFIX} ${site.name} DOWN (#${s.downCount}) — ${error}`);

      if (s.downCount === 1 || s.downCount % REPEAT_ALERT === 0) {
        await sendAlert(
          `🔴 DOWN: ${site.name} (${site.url})`,
          buildDownEmail(site, error, s.downSince, s.downCount),
          site
        );
      }
    } else {
      if (s.downCount > 0) {
        const downDuration = formatDuration(Date.now() - new Date(s.downSince).getTime());
        console.log(`${LOG_PREFIX} ${site.name} RECOVERED after ${downDuration}`);

        await sendAlert(
          `✅ UP: ${site.name} is back online (was down ${downDuration})`,
          buildUpEmail(site, result.detail.latency, s.downSince, downDuration),
          site
        );
      }
      s.downCount = 0;
      s.downSince = null;
      console.log(`${LOG_PREFIX} ${site.name} UP — ${result.detail.latency}ms`);
    }
  }));

  uptimeStore.saveData(data);
  console.log(`${LOG_PREFIX} Done.`);
}

// ── Run ──
if (process.argv.includes('--once')) {
  monitorCycle()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
} else {
  console.log(`${LOG_PREFIX} Monitoring ${sites.length} site(s) every ${INTERVAL}m.`);
  cron.schedule(`*/${INTERVAL} * * * *`, () => {
    monitorCycle().catch(err => console.error(`${LOG_PREFIX} Error:`, err));
  });
  monitorCycle().catch(err => console.error(`${LOG_PREFIX} Error:`, err));
}

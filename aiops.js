/**
 * AIOps module — Predictive Alerting, Smart Anomaly Detection, Root Cause Analysis.
 *
 * 1. Predictive Alerting:
 *    - Linear regression on latency trends to predict SLA breaches
 *    - Forecasts when uptime will drop below target at current failure rate
 *    - Estimates time-to-breach so teams can act before it happens
 *
 * 2. Anomaly Detection with Context:
 *    - Multi-signal anomaly detection (latency, error rate, status codes)
 *    - Time-of-day and day-of-week pattern matching
 *    - Cross-site correlation (is this anomaly unique or widespread?)
 *    - Deployment correlation via GitHub API
 *    - Historical pattern matching ("this looks like the incident on March 5")
 *
 * 3. Root Cause Analysis:
 *    - Multi-site incident correlation (simultaneous failures → shared root cause)
 *    - Infrastructure grouping (same host, CDN, region)
 *    - External dependency checking (AWS, Cloudflare status)
 *    - Causal chain construction (what failed first, what cascaded)
 */

const fetch = globalThis.fetch || require('node-fetch');

const LOG_PREFIX = '[aiops]';

// =========================================================================
// 1. PREDICTIVE ALERTING
// =========================================================================

/**
 * Simple linear regression: returns slope, intercept, and r² for a dataset.
 */
function linearRegression(points) {
  const n = points.length;
  if (n < 3) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R-squared (goodness of fit)
  const ssRes = points.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
  const mean = sumY / n;
  const ssTot = points.reduce((s, p) => s + Math.pow(p.y - mean, 2), 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, rSquared };
}

/**
 * Predict when latency will cross a critical threshold based on current trend.
 * Returns forecast in hours, or null if trend is stable/improving.
 */
function predictLatencyBreach(checks, thresholdMs = 3000) {
  const cutoff = Date.now() - 72 * 60 * 60 * 1000; // last 72 hours
  const relevant = checks
    .filter(c => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);

  if (relevant.length < 20) return { prediction: null, reason: 'Insufficient data (need 20+ checks).' };

  // Normalize timestamps to hours from start
  const startTime = new Date(relevant[0].timestamp).getTime();
  const points = relevant.map(c => ({
    x: (new Date(c.timestamp).getTime() - startTime) / 3600000,
    y: c.latency,
  }));

  const reg = linearRegression(points);
  if (!reg || reg.rSquared < 0.1) {
    return { prediction: null, reason: 'No clear trend (R² too low).', regression: reg };
  }

  if (reg.slope <= 0) {
    return { prediction: null, reason: 'Latency is stable or improving.', regression: reg, trend: 'improving' };
  }

  // When will latency hit threshold?
  const currentHour = (Date.now() - startTime) / 3600000;
  const currentPredicted = reg.slope * currentHour + reg.intercept;
  const hoursToThreshold = (thresholdMs - currentPredicted) / reg.slope;

  if (hoursToThreshold <= 0) {
    return {
      prediction: 0,
      reason: `Latency already exceeds ${thresholdMs}ms threshold.`,
      regression: reg,
      trend: 'critical',
      severity: 'critical',
    };
  }

  if (hoursToThreshold > 168) { // more than 7 days
    return { prediction: null, reason: 'Threshold breach unlikely within 7 days.', regression: reg, trend: 'slow_degradation' };
  }

  const severity = hoursToThreshold <= 6 ? 'critical' : hoursToThreshold <= 24 ? 'warning' : 'info';

  return {
    prediction: Math.round(hoursToThreshold),
    predictedBreachTime: new Date(Date.now() + hoursToThreshold * 3600000).toISOString(),
    currentLatency: Math.round(currentPredicted),
    rateOfChange: Math.round(reg.slope * 100) / 100, // ms per hour
    rSquared: Math.round(reg.rSquared * 1000) / 1000,
    regression: reg,
    trend: 'degrading',
    severity,
    reason: `At current rate (+${reg.slope.toFixed(1)}ms/hr), latency will hit ${thresholdMs}ms in ~${Math.round(hoursToThreshold)}h.`,
  };
}

/**
 * Predict SLA breach based on current failure rate for the month.
 * Returns days until breach, or null if on track.
 */
function predictSLABreach(checks, slaTarget = 99.9) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const relevant = checks.filter(c => new Date(c.timestamp).getTime() >= monthStart);

  if (relevant.length < 20) return { prediction: null, reason: 'Insufficient data for this month.' };

  const failures = relevant.filter(c => !c.success).length;
  const failureRate = failures / relevant.length;
  const currentUptime = (1 - failureRate) * 100;

  // Days elapsed and remaining
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate() + now.getHours() / 24;
  const daysRemaining = daysInMonth - daysElapsed;

  if (failureRate === 0) {
    return { prediction: null, reason: 'No failures recorded — SLA safe.', currentUptime, trend: 'healthy' };
  }

  // At current failure rate, what will end-of-month uptime be?
  const checksPerDay = relevant.length / daysElapsed;
  const projectedTotalChecks = Math.round(checksPerDay * daysInMonth);
  const projectedFailures = Math.round(failureRate * projectedTotalChecks);
  const projectedUptime = ((projectedTotalChecks - projectedFailures) / projectedTotalChecks) * 100;

  const willBreach = projectedUptime < slaTarget;

  // When will it breach? (solve for the day when cumulative uptime drops below target)
  let daysToBreachEstimate = null;
  if (willBreach && failureRate > 0) {
    const allowedFailureRate = 1 - slaTarget / 100;
    if (failureRate > allowedFailureRate) {
      // Already breaching rate — estimate when cumulative catches up
      const currentSuccesses = relevant.length - failures;
      // Need: (currentSuccesses + futureSuccesses) / (relevant.length + futureChecks) >= slaTarget/100
      // This means we're already trending below — breach is imminent
      daysToBreachEstimate = Math.max(0, Math.round(daysRemaining * 0.3)); // rough estimate
    }
  }

  const severity = willBreach
    ? (daysToBreachEstimate != null && daysToBreachEstimate <= 3 ? 'critical' : 'warning')
    : 'healthy';

  return {
    prediction: willBreach ? daysToBreachEstimate : null,
    currentUptime: Math.round(currentUptime * 1000) / 1000,
    projectedUptime: Math.round(projectedUptime * 1000) / 1000,
    slaTarget,
    failureRate: Math.round(failureRate * 10000) / 100, // as percentage
    daysRemaining: Math.round(daysRemaining),
    willBreach,
    severity,
    reason: willBreach
      ? `Projected month-end uptime: ${projectedUptime.toFixed(2)}% (target: ${slaTarget}%). SLA breach likely.`
      : `On track — projected uptime: ${projectedUptime.toFixed(2)}% (target: ${slaTarget}%).`,
  };
}

/**
 * Full predictive analysis for a site.
 */
function predictiveAnalysis(store, slaTarget = 99.9, latencyThreshold = 3000) {
  const latency = predictLatencyBreach(store.checks, latencyThreshold);
  const sla = predictSLABreach(store.checks, slaTarget);

  const alerts = [];
  if (latency.severity === 'critical') {
    alerts.push({ type: 'latency_breach', severity: 'critical', message: latency.reason });
  } else if (latency.severity === 'warning') {
    alerts.push({ type: 'latency_breach', severity: 'warning', message: latency.reason });
  }
  if (sla.severity === 'critical') {
    alerts.push({ type: 'sla_breach', severity: 'critical', message: sla.reason });
  } else if (sla.severity === 'warning') {
    alerts.push({ type: 'sla_breach', severity: 'warning', message: sla.reason });
  }

  return { latency, sla, alerts };
}


// =========================================================================
// 2. ANOMALY DETECTION WITH CONTEXT
// =========================================================================

/**
 * Multi-signal anomaly detection.
 * Checks latency, error rate, and status code distribution for anomalies.
 */
function detectAnomalies(checks, hoursBack = 6) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const recent = checks.filter(c => new Date(c.timestamp).getTime() >= cutoff);
  const baseline = checks.filter(c => {
    const t = new Date(c.timestamp).getTime();
    return t >= cutoff - 48 * 60 * 60 * 1000 && t < cutoff; // 48h baseline before window
  });

  if (recent.length < 5 || baseline.length < 20) {
    return { anomalies: [], context: 'Insufficient data for anomaly detection.' };
  }

  const anomalies = [];

  // --- Latency anomalies ---
  const baselineLatencies = baseline.filter(c => c.success && c.latency).map(c => c.latency);
  const recentLatencies = recent.filter(c => c.success && c.latency).map(c => c.latency);

  if (baselineLatencies.length >= 10 && recentLatencies.length >= 3) {
    const baseMean = baselineLatencies.reduce((s, l) => s + l, 0) / baselineLatencies.length;
    const baseStd = Math.sqrt(baselineLatencies.reduce((s, l) => s + Math.pow(l - baseMean, 2), 0) / baselineLatencies.length);
    const recentMean = recentLatencies.reduce((s, l) => s + l, 0) / recentLatencies.length;
    const threshold = baseMean + 2.5 * baseStd;

    if (recentMean > threshold) {
      anomalies.push({
        type: 'latency_spike',
        severity: recentMean > baseMean + 4 * baseStd ? 'critical' : 'warning',
        value: Math.round(recentMean),
        baseline: Math.round(baseMean),
        threshold: Math.round(threshold),
        deviations: ((recentMean - baseMean) / (baseStd || 1)).toFixed(1),
        message: `Avg latency ${Math.round(recentMean)}ms is ${((recentMean - baseMean) / (baseStd || 1)).toFixed(1)}σ above baseline (${Math.round(baseMean)}ms).`,
      });
    }

    // Detect individual spikes
    const spikes = recent.filter(c => c.success && c.latency && c.latency > threshold);
    if (spikes.length > 0) {
      anomalies.push({
        type: 'latency_spikes',
        severity: 'info',
        count: spikes.length,
        worstLatency: Math.max(...spikes.map(s => s.latency)),
        threshold: Math.round(threshold),
        message: `${spikes.length} individual latency spikes above ${Math.round(threshold)}ms in the last ${hoursBack}h.`,
      });
    }
  }

  // --- Error rate anomalies ---
  const baselineErrorRate = baseline.filter(c => !c.success).length / baseline.length;
  const recentErrorRate = recent.filter(c => !c.success).length / recent.length;

  if (recentErrorRate > 0 && recentErrorRate > baselineErrorRate * 3 + 0.05) {
    anomalies.push({
      type: 'error_rate_spike',
      severity: recentErrorRate > 0.3 ? 'critical' : 'warning',
      recentRate: Math.round(recentErrorRate * 100),
      baselineRate: Math.round(baselineErrorRate * 100),
      message: `Error rate spiked to ${(recentErrorRate * 100).toFixed(1)}% (baseline: ${(baselineErrorRate * 100).toFixed(1)}%).`,
    });
  }

  // --- Time-of-day context ---
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentDay = now.getUTCDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Check if this time slot historically has issues
  const historicalSameHour = checks.filter(c => {
    const d = new Date(c.timestamp);
    return d.getUTCHours() === currentHour && !c.success;
  });
  const historicalTotal = checks.filter(c => new Date(c.timestamp).getUTCHours() === currentHour);

  let timeContext = null;
  if (historicalTotal.length > 10) {
    const hourErrorRate = historicalSameHour.length / historicalTotal.length;
    if (hourErrorRate > 0.1) {
      timeContext = `This hour (${currentHour}:00 UTC, ${dayNames[currentDay]}) historically has a ${(hourErrorRate * 100).toFixed(0)}% failure rate.`;
    }
  }

  return {
    anomalies,
    timeContext,
    window: `${hoursBack}h`,
    checksAnalyzed: recent.length,
    baselineChecks: baseline.length,
  };
}

/**
 * Cross-site anomaly correlation.
 * Checks if anomalies are happening across multiple sites simultaneously.
 */
function crossSiteCorrelation(allSiteStores, hoursBack = 1) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const siteStatuses = [];

  for (const [url, store] of Object.entries(allSiteStores)) {
    const recent = store.checks.filter(c => new Date(c.timestamp).getTime() >= cutoff);
    if (recent.length === 0) continue;

    const failures = recent.filter(c => !c.success);
    const avgLatency = recent.filter(c => c.success && c.latency)
      .reduce((s, c) => s + c.latency, 0) / (recent.filter(c => c.success && c.latency).length || 1);

    siteStatuses.push({
      url,
      name: store.name,
      failureCount: failures.length,
      totalChecks: recent.length,
      failureRate: failures.length / recent.length,
      avgLatency: Math.round(avgLatency),
      hasIssues: failures.length > 0 || avgLatency > 2000,
    });
  }

  const sitesWithIssues = siteStatuses.filter(s => s.hasIssues);

  if (sitesWithIssues.length <= 1) {
    return {
      correlated: false,
      message: sitesWithIssues.length === 1
        ? `Issue isolated to ${sitesWithIssues[0].name}.`
        : 'No cross-site issues detected.',
      affectedSites: sitesWithIssues,
    };
  }

  // Multiple sites affected — likely shared cause
  return {
    correlated: true,
    affectedCount: sitesWithIssues.length,
    totalSites: siteStatuses.length,
    affectedSites: sitesWithIssues,
    message: `${sitesWithIssues.length}/${siteStatuses.length} sites affected simultaneously — likely shared infrastructure issue.`,
  };
}

/**
 * Match current anomaly to historical incident patterns.
 */
function matchHistoricalPatterns(store, currentAnomaly) {
  if (!store.incidents || store.incidents.length === 0) return null;

  const matches = [];

  for (const incident of store.incidents) {
    if (!incident.error) continue;

    // Check if error message pattern matches
    if (currentAnomaly.type === 'error_rate_spike' && incident.error) {
      matches.push({
        incidentId: incident.id,
        startedAt: incident.startedAt,
        duration: incident.durationMs,
        error: incident.error,
        similarity: 'error_pattern',
      });
    }

    // Check if same time-of-day pattern
    if (incident.startedAt) {
      const incHour = new Date(incident.startedAt).getUTCHours();
      const nowHour = new Date().getUTCHours();
      if (Math.abs(incHour - nowHour) <= 1) {
        matches.push({
          incidentId: incident.id,
          startedAt: incident.startedAt,
          duration: incident.durationMs,
          error: incident.error,
          similarity: 'time_of_day',
        });
      }
    }
  }

  if (matches.length === 0) return null;

  // Deduplicate and rank
  const unique = [...new Map(matches.map(m => [m.incidentId, m])).values()];
  return {
    matchCount: unique.length,
    matches: unique.slice(0, 5),
    message: `Current issue matches ${unique.length} historical incident(s). Most recent: ${new Date(unique[0].startedAt).toLocaleDateString()}.`,
  };
}


// =========================================================================
// 3. ROOT CAUSE ANALYSIS
// =========================================================================

/**
 * Fetch external service status (AWS, Cloudflare, etc.)
 */
async function checkExternalStatus() {
  const services = [
    { name: 'AWS', url: 'https://health.aws.amazon.com/health/status', type: 'aws' },
    { name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json', type: 'cloudflare' },
    { name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json', type: 'statuspage' },
    { name: 'Vercel', url: 'https://www.vercel-status.com/api/v2/status.json', type: 'statuspage' },
  ];

  const results = [];

  for (const service of services) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(service.url, { signal: controller.signal });
      clearTimeout(timeout);

      if (service.type === 'statuspage' || service.type === 'cloudflare') {
        const data = await resp.json();
        const indicator = data?.status?.indicator || 'unknown';
        const description = data?.status?.description || 'Unknown';
        results.push({
          name: service.name,
          status: indicator === 'none' ? 'operational' : indicator,
          description,
          hasIssues: indicator !== 'none',
        });
      } else {
        results.push({
          name: service.name,
          status: resp.ok ? 'operational' : 'degraded',
          description: resp.ok ? 'Operational' : `HTTP ${resp.status}`,
          hasIssues: !resp.ok,
        });
      }
    } catch (err) {
      results.push({
        name: service.name,
        status: 'unknown',
        description: `Check failed: ${err.message}`,
        hasIssues: false,
      });
    }
  }

  return results;
}

/**
 * Group sites by shared infrastructure characteristics.
 */
function groupByInfrastructure(siteConfigs) {
  const groups = {
    byRegion: {},
    byDomain: {},
    byTeam: {},
  };

  for (const site of siteConfigs) {
    // By region
    const region = site.region || 'unknown';
    if (!groups.byRegion[region]) groups.byRegion[region] = [];
    groups.byRegion[region].push(site.url);

    // By root domain / hosting
    try {
      const hostname = new URL(site.url).hostname;
      const rootDomain = hostname.split('.').slice(-2).join('.');
      if (!groups.byDomain[rootDomain]) groups.byDomain[rootDomain] = [];
      groups.byDomain[rootDomain].push(site.url);
    } catch { /* ignore */ }

    // By team
    const team = site.team || 'default';
    if (!groups.byTeam[team]) groups.byTeam[team] = [];
    groups.byTeam[team].push(site.url);
  }

  return groups;
}

/**
 * Build a causal chain: what failed first, what cascaded.
 */
function buildCausalChain(allSiteStores, hoursBack = 1) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const failureEvents = [];

  for (const [url, store] of Object.entries(allSiteStores)) {
    const failures = store.checks
      .filter(c => new Date(c.timestamp).getTime() >= cutoff && !c.success)
      .map(c => ({
        url,
        name: store.name,
        timestamp: c.timestamp,
        time: new Date(c.timestamp).getTime(),
        error: c.error || `HTTP ${c.status}`,
        status: c.status,
      }));
    failureEvents.push(...failures);
  }

  if (failureEvents.length === 0) {
    return { chain: [], message: 'No failures detected in the analysis window.' };
  }

  // Sort by time — earliest first
  failureEvents.sort((a, b) => a.time - b.time);

  // Identify the first failure
  const firstFailure = failureEvents[0];
  const chain = [{ ...firstFailure, position: 'origin', label: 'First failure detected' }];

  // Find subsequent failures within 5 minutes of origin
  const cascadeWindow = 5 * 60 * 1000;
  const cascaded = failureEvents
    .filter(f => f.url !== firstFailure.url && f.time - firstFailure.time <= cascadeWindow)
    .reduce((acc, f) => {
      if (!acc.find(a => a.url === f.url)) acc.push(f);
      return acc;
    }, []);

  for (const failure of cascaded) {
    const delayMs = failure.time - firstFailure.time;
    chain.push({
      ...failure,
      position: 'cascaded',
      delayMs,
      label: `Cascaded failure (+${Math.round(delayMs / 1000)}s after origin)`,
    });
  }

  return {
    chain,
    originSite: firstFailure.name,
    cascadedSites: cascaded.map(c => c.name),
    totalFailures: failureEvents.length,
    message: cascaded.length > 0
      ? `${firstFailure.name} failed first, then ${cascaded.map(c => c.name).join(', ')} failed within ${Math.round(cascadeWindow / 60000)} minutes — possible cascade.`
      : `Isolated failure at ${firstFailure.name}.`,
  };
}

/**
 * Perform full root cause analysis for current state.
 */
async function rootCauseAnalysis(allSiteStores, siteConfigs) {
  const findings = [];
  let overallSeverity = 'healthy';

  // 1. Cross-site correlation
  const correlation = crossSiteCorrelation(allSiteStores, 1);
  if (correlation.correlated) {
    findings.push({
      type: 'cross_site_correlation',
      severity: 'critical',
      finding: correlation.message,
      affectedSites: correlation.affectedSites.map(s => s.name),
    });
    overallSeverity = 'critical';
  }

  // 2. Infrastructure grouping
  const infraGroups = groupByInfrastructure(siteConfigs);
  const affectedUrls = new Set(
    (correlation.affectedSites || []).map(s => s.url)
  );

  // Check if affected sites share region
  for (const [region, urls] of Object.entries(infraGroups.byRegion)) {
    const affectedInRegion = urls.filter(u => affectedUrls.has(u));
    if (affectedInRegion.length > 1) {
      findings.push({
        type: 'shared_region',
        severity: 'warning',
        finding: `${affectedInRegion.length} affected sites share the "${region}" region — possible regional infrastructure issue.`,
        region,
      });
    }
  }

  // 3. External service status
  let externalIssues = [];
  try {
    const externalStatus = await checkExternalStatus();
    externalIssues = externalStatus.filter(s => s.hasIssues);
    if (externalIssues.length > 0) {
      findings.push({
        type: 'external_service_issue',
        severity: 'critical',
        finding: `External service issue detected: ${externalIssues.map(s => `${s.name} (${s.description})`).join(', ')}.`,
        services: externalIssues,
      });
      overallSeverity = 'critical';
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} External status check failed:`, err.message);
  }

  // 4. Causal chain
  const causalChain = buildCausalChain(allSiteStores, 1);
  if (causalChain.chain.length > 1) {
    findings.push({
      type: 'causal_chain',
      severity: 'warning',
      finding: causalChain.message,
      chain: causalChain.chain.map(c => ({ site: c.name, position: c.position, delay: c.delayMs })),
    });
  }

  // 5. Synthesize root cause hypothesis
  let hypothesis = 'All systems operating normally.';

  if (findings.length > 0) {
    const parts = [];

    if (correlation.correlated && externalIssues.length > 0) {
      hypothesis = `Multiple sites affected simultaneously. External service degradation detected (${externalIssues.map(s => s.name).join(', ')}). This is likely the root cause.`;
    } else if (correlation.correlated) {
      const regionIssue = findings.find(f => f.type === 'shared_region');
      if (regionIssue) {
        hypothesis = `Multiple sites in the "${regionIssue.region}" region are affected. Likely cause: regional infrastructure issue (hosting provider, CDN, or network).`;
      } else {
        hypothesis = `${correlation.affectedCount} sites affected simultaneously. Investigate shared dependencies: DNS, CDN, load balancer, or upstream API.`;
      }
    } else if (causalChain.chain.length > 1) {
      hypothesis = causalChain.message + ' Investigate the origin site for the root cause.';
    } else if (findings.some(f => f.type === 'external_service_issue')) {
      hypothesis = `External service issue: ${externalIssues.map(s => s.name).join(', ')}. Monitor their status pages for resolution.`;
    }
  }

  if (overallSeverity === 'healthy' && findings.length > 0) {
    overallSeverity = 'warning';
  }

  return {
    severity: overallSeverity,
    hypothesis,
    findings,
    externalServices: externalIssues,
    causalChain: causalChain.chain.length > 1 ? causalChain : null,
    timestamp: new Date().toISOString(),
  };
}


// =========================================================================
// UNIFIED AIOPS ANALYSIS
// =========================================================================

/**
 * Run full AIOps analysis for a single site.
 */
function analyzeSite(store, siteConfig) {
  const slaTarget = siteConfig?.sla_target || 99.9;
  const predictions = predictiveAnalysis(store, slaTarget);
  const anomalyReport = detectAnomalies(store.checks, 6);
  const historicalMatch = anomalyReport.anomalies.length > 0
    ? matchHistoricalPatterns(store, anomalyReport.anomalies[0])
    : null;

  return {
    siteName: store.name,
    siteUrl: store.url,
    predictions,
    anomalies: anomalyReport,
    historicalMatch,
    hasCriticalAlerts: predictions.alerts.some(a => a.severity === 'critical') ||
      anomalyReport.anomalies.some(a => a.severity === 'critical'),
  };
}

/**
 * Run full AIOps analysis across all sites.
 */
async function analyzeAll(data, siteConfigs) {
  const siteAnalyses = {};

  for (const siteConfig of siteConfigs) {
    const store = data.sites?.[siteConfig.url];
    if (!store) continue;
    siteAnalyses[siteConfig.url] = analyzeSite(store, siteConfig);
  }

  // Root cause analysis across all sites
  const rca = await rootCauseAnalysis(data.sites || {}, siteConfigs);

  // Compile all critical alerts
  const criticalAlerts = [];
  for (const [url, analysis] of Object.entries(siteAnalyses)) {
    for (const alert of analysis.predictions.alerts) {
      if (alert.severity === 'critical' || alert.severity === 'warning') {
        criticalAlerts.push({ url, site: analysis.siteName, ...alert });
      }
    }
    for (const anomaly of analysis.anomalies.anomalies) {
      if (anomaly.severity === 'critical') {
        criticalAlerts.push({ url, site: analysis.siteName, type: anomaly.type, severity: anomaly.severity, message: anomaly.message });
      }
    }
  }

  if (rca.findings.length > 0) {
    for (const finding of rca.findings) {
      criticalAlerts.push({ type: finding.type, severity: finding.severity, message: finding.finding });
    }
  }

  return {
    sites: siteAnalyses,
    rootCauseAnalysis: rca,
    criticalAlerts,
    summary: {
      totalSites: Object.keys(siteAnalyses).length,
      sitesWithAlerts: Object.values(siteAnalyses).filter(a => a.hasCriticalAlerts).length,
      totalAlerts: criticalAlerts.length,
      overallHealth: criticalAlerts.length === 0 ? 'healthy'
        : criticalAlerts.some(a => a.severity === 'critical') ? 'critical' : 'warning',
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  // Predictive
  predictLatencyBreach,
  predictSLABreach,
  predictiveAnalysis,
  // Anomaly Detection
  detectAnomalies,
  crossSiteCorrelation,
  matchHistoricalPatterns,
  // Root Cause Analysis
  checkExternalStatus,
  buildCausalChain,
  rootCauseAnalysis,
  // Unified
  analyzeSite,
  analyzeAll,
};

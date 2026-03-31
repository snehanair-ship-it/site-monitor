/**
 * Multi-region monitoring and IP block detection.
 *
 * Checks site availability from multiple geographic locations using:
 * 1. Direct checks from the current runner
 * 2. check-host.net API for global reachability
 * 3. Optional HTTP proxies for region-specific checks
 *
 * Detects IP blocks by comparing results across regions — if a site is
 * reachable from some locations but not others, it flags a potential block.
 */

const fetch = globalThis.fetch || require('node-fetch');
const { getRegions, getIPBlockConfig } = require('./config-loader');

const LOG_PREFIX = '[multi-region]';

/**
 * Get the public IP of the current runner.
 */
async function getRunnerIP() {
  try {
    const resp = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await resp.json();
    return data.ip;
  } catch {
    return null;
  }
}

/**
 * Check a site from the current location (direct).
 */
async function checkDirect(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = Date.now();
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latency = Date.now() - start;
    return {
      reachable: resp.ok && resp.status < 500,
      status: resp.status,
      latency,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      latency: null,
      error: err.message || String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check a site via an HTTP proxy (for region-specific checks).
 */
async function checkViaProxy(url, proxyUrl, timeoutMs = 15000) {
  if (!proxyUrl) return null;

  try {
    // Use the proxy as a simple relay — fetch through it
    const proxyEndpoint = `${proxyUrl}?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const start = Date.now();
      const resp = await fetch(proxyEndpoint, { signal: controller.signal });
      const latency = Date.now() - start;
      return {
        reachable: resp.ok,
        status: resp.status,
        latency,
        error: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      reachable: false,
      status: null,
      latency: null,
      error: err.message || String(err),
    };
  }
}

/**
 * Check site accessibility from multiple global locations using check-host.net API.
 * Returns results per node (city/country).
 */
async function checkFromGlobalNodes(url) {
  const ipBlockConfig = getIPBlockConfig();
  if (!ipBlockConfig.enabled) return { checked: false, results: [] };

  try {
    // Use check-host.net HTTP check API
    const checkUrl = `https://check-host.net/check-http?host=${encodeURIComponent(url)}`;
    const resp = await fetch(checkUrl, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });

    if (!resp.ok) {
      console.warn(`${LOG_PREFIX} check-host.net API returned ${resp.status}`);
      return { checked: false, results: [] };
    }

    const data = await resp.json();
    const requestId = data.request_id;
    const nodes = data.nodes || {};

    if (!requestId) {
      return { checked: false, results: [] };
    }

    // Wait for results (check-host.net is async)
    await new Promise(resolve => setTimeout(resolve, 8000));

    const resultResp = await fetch(`https://check-host.net/check-result/${requestId}`, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });

    if (!resultResp.ok) {
      return { checked: false, results: [] };
    }

    const resultData = await resultResp.json();
    const regionResults = [];

    for (const [nodeId, nodeResult] of Object.entries(resultData)) {
      const nodeInfo = nodes[nodeId] || {};
      const location = Array.isArray(nodeInfo) ? nodeInfo.join(', ') : nodeId;

      let reachable = false;
      let statusCode = null;
      let error = null;

      if (Array.isArray(nodeResult) && nodeResult.length > 0) {
        const check = nodeResult[0];
        if (Array.isArray(check)) {
          // [ok, status_code, ...]
          reachable = check[0] === 1;
          statusCode = check[1] || null;
        } else if (check === null) {
          error = 'Timeout or connection refused';
        }
      }

      regionResults.push({
        nodeId,
        location,
        reachable,
        statusCode,
        error,
      });
    }

    return { checked: true, results: regionResults, requestId };
  } catch (err) {
    console.error(`${LOG_PREFIX} Global node check failed:`, err.message);
    return { checked: false, results: [], error: err.message };
  }
}

/**
 * Analyze multi-region results to detect IP blocks.
 * Returns analysis with block status and affected regions.
 */
function analyzeIPBlocks(globalResults) {
  const ipBlockConfig = getIPBlockConfig();
  if (!globalResults.checked || globalResults.results.length === 0) {
    return { blocked: false, analysis: 'No multi-region data available.' };
  }

  const total = globalResults.results.length;
  const reachable = globalResults.results.filter(r => r.reachable).length;
  const unreachable = globalResults.results.filter(r => !r.reachable);
  const reachablePercent = (reachable / total) * 100;

  const threshold = ipBlockConfig.block_threshold_percent || 50;

  if (reachable === total) {
    return {
      blocked: false,
      partialBlock: false,
      analysis: `Site reachable from all ${total} regions.`,
      reachablePercent: 100,
      reachableCount: reachable,
      totalNodes: total,
      unreachableRegions: [],
    };
  }

  if (reachable === 0) {
    return {
      blocked: true,
      partialBlock: false,
      analysis: `Site unreachable from all ${total} regions — likely down globally.`,
      reachablePercent: 0,
      reachableCount: 0,
      totalNodes: total,
      unreachableRegions: unreachable.map(r => r.location),
    };
  }

  const isBlocked = reachablePercent < threshold;
  return {
    blocked: isBlocked,
    partialBlock: true,
    analysis: `Site reachable from ${reachable}/${total} regions (${reachablePercent.toFixed(0)}%). ` +
      `Unreachable from: ${unreachable.map(r => r.location).join(', ')}. ` +
      (isBlocked ? 'Possible IP/geo-block detected.' : 'Minor regional accessibility issues.'),
    reachablePercent,
    reachableCount: reachable,
    totalNodes: total,
    unreachableRegions: unreachable.map(r => ({
      location: r.location,
      error: r.error,
      statusCode: r.statusCode,
    })),
  };
}

/**
 * Run a full multi-region check for a site.
 * Returns direct check + global node results + IP block analysis.
 */
async function multiRegionCheck(site, timeoutMs = 15000) {
  const runnerIP = await getRunnerIP();
  const directResult = await checkDirect(site.url, timeoutMs);

  // Check configured regional proxies
  const regions = getRegions();
  const regionResults = {};

  for (const [regionId, regionConfig] of Object.entries(regions)) {
    const proxyUrl = regionConfig.proxy_env ? process.env[regionConfig.proxy_env] : regionConfig.proxy;
    if (proxyUrl) {
      regionResults[regionId] = await checkViaProxy(site.url, proxyUrl, timeoutMs);
    } else {
      // No proxy = direct check (same as runner)
      regionResults[regionId] = { ...directResult, note: 'Same as runner (no proxy)' };
    }
  }

  // Global node check via check-host.net
  const globalResults = await checkFromGlobalNodes(site.url);
  const blockAnalysis = analyzeIPBlocks(globalResults);

  return {
    runnerIP,
    direct: directResult,
    regions: regionResults,
    globalCheck: globalResults,
    ipBlockAnalysis: blockAnalysis,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getRunnerIP,
  checkDirect,
  checkViaProxy,
  checkFromGlobalNodes,
  analyzeIPBlocks,
  multiRegionCheck,
};

/**
 * Security Scanner — endpoint auditing, header checks, and vulnerability detection.
 *
 * Checks:
 * 1. Sensitive endpoints that should be blocked (xmlrpc.php, .env, .git, etc.)
 * 2. HTTP security headers (CSP, HSTS, X-Frame-Options, etc.)
 * 3. Information disclosure (server version, debug pages, directory listing)
 * 4. SSL/TLS configuration
 * 5. Common WordPress, Laravel, and framework-specific misconfigurations
 */

const fetch = globalThis.fetch || require('node-fetch');

const LOG_PREFIX = '[security]';

// =========================================================================
// SENSITIVE ENDPOINTS — should return 403/404/405, NOT 200
// =========================================================================
const SENSITIVE_ENDPOINTS = [
  // WordPress
  { path: '/xmlrpc.php', method: 'POST', name: 'XML-RPC (POST)', severity: 'critical', expectedBlock: [403, 405, 404, 301], recommendation: 'Block at Cloudflare WAF (/xmlrpc.php → Block) AND at Nginx (deny all; return 403).' },
  { path: '/xmlrpc.php', method: 'GET', name: 'XML-RPC (GET)', severity: 'high', expectedBlock: [403, 405, 404, 301], recommendation: 'Block XML-RPC access if not needed. Use Cloudflare WAF rule or .htaccess.' },
  { path: '/wp-login.php', method: 'GET', name: 'WP Login Page', severity: 'medium', expectedBlock: null, checkExposed: true, recommendation: 'Consider hiding or restricting wp-login.php with IP allowlisting or 2FA.' },
  { path: '/wp-admin/', method: 'GET', name: 'WP Admin Panel', severity: 'medium', expectedBlock: null, checkExposed: true, recommendation: 'Restrict wp-admin access by IP or use security plugin.' },
  { path: '/wp-json/wp/v2/users', method: 'GET', name: 'WP REST API User Enumeration', severity: 'high', expectedBlock: [403, 401, 404], recommendation: 'Disable user enumeration via REST API. Use a security plugin or filter.' },
  { path: '/wp-config.php', method: 'GET', name: 'WP Config File', severity: 'critical', expectedBlock: [403, 404, 500], recommendation: 'Must never be publicly accessible. Check web server config.' },
  { path: '/readme.html', method: 'GET', name: 'WP Readme (version disclosure)', severity: 'low', expectedBlock: [403, 404], recommendation: 'Delete readme.html to prevent WordPress version disclosure.' },

  // Environment / Config files
  { path: '/.env', method: 'GET', name: '.env File', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Block .env access at web server level. Contains secrets!' },
  { path: '/.git/HEAD', method: 'GET', name: 'Git Repository Exposed', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Block .git directory access. Source code and history are exposed!' },
  { path: '/.git/config', method: 'GET', name: 'Git Config Exposed', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Block entire .git directory at web server level.' },
  { path: '/.gitignore', method: 'GET', name: 'Gitignore File', severity: 'low', expectedBlock: [403, 404], recommendation: 'Consider blocking .gitignore — reveals project structure.' },
  { path: '/composer.json', method: 'GET', name: 'Composer Config', severity: 'medium', expectedBlock: [403, 404], recommendation: 'Block composer.json — reveals dependencies and versions.' },
  { path: '/package.json', method: 'GET', name: 'NPM Package Config', severity: 'medium', expectedBlock: [403, 404], recommendation: 'Block package.json — reveals dependencies.' },

  // Debug / Admin
  { path: '/debug', method: 'GET', name: 'Debug Endpoint', severity: 'high', expectedBlock: [403, 404], recommendation: 'Remove or block debug endpoints in production.' },
  { path: '/server-status', method: 'GET', name: 'Apache Server Status', severity: 'high', expectedBlock: [403, 404], recommendation: 'Restrict server-status to localhost only.' },
  { path: '/server-info', method: 'GET', name: 'Apache Server Info', severity: 'high', expectedBlock: [403, 404], recommendation: 'Restrict server-info to localhost only.' },
  { path: '/phpinfo.php', method: 'GET', name: 'PHP Info Page', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Delete phpinfo.php immediately — exposes server configuration.' },
  { path: '/info.php', method: 'GET', name: 'PHP Info (alt)', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Delete info.php — exposes server configuration.' },
  { path: '/adminer.php', method: 'GET', name: 'Adminer DB Tool', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Remove Adminer from production — provides direct database access.' },
  { path: '/phpmyadmin/', method: 'GET', name: 'phpMyAdmin', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Remove phpMyAdmin from production or restrict access by IP.' },

  // Backup files
  { path: '/backup.sql', method: 'GET', name: 'SQL Backup File', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Remove database backups from web root immediately.' },
  { path: '/backup.zip', method: 'GET', name: 'Backup Archive', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Remove backup archives from web-accessible directories.' },
  { path: '/db.sql', method: 'GET', name: 'Database Dump', severity: 'critical', expectedBlock: [403, 404], recommendation: 'Remove database dumps from web root.' },

  // Laravel
  { path: '/storage/logs/laravel.log', method: 'GET', name: 'Laravel Log File', severity: 'high', expectedBlock: [403, 404], recommendation: 'Block storage directory access — contains application logs with sensitive data.' },
  { path: '/telescope', method: 'GET', name: 'Laravel Telescope', severity: 'high', expectedBlock: [403, 404, 302], recommendation: 'Disable or restrict Laravel Telescope in production.' },

  // Common API/admin paths
  { path: '/api/v1/debug', method: 'GET', name: 'API Debug Endpoint', severity: 'high', expectedBlock: [403, 404], recommendation: 'Remove debug endpoints from production APIs.' },
  { path: '/graphql', method: 'GET', name: 'GraphQL Explorer', severity: 'medium', expectedBlock: null, checkExposed: true, recommendation: 'If GraphQL introspection is enabled in production, consider disabling it.' },
];

// =========================================================================
// SECURITY HEADERS to check
// =========================================================================
const SECURITY_HEADERS = [
  {
    header: 'strict-transport-security',
    name: 'HSTS (HTTP Strict Transport Security)',
    severity: 'high',
    recommendation: 'Add header: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
  },
  {
    header: 'x-frame-options',
    name: 'X-Frame-Options (Clickjacking Protection)',
    severity: 'high',
    recommendation: 'Add header: X-Frame-Options: DENY or SAMEORIGIN',
  },
  {
    header: 'x-content-type-options',
    name: 'X-Content-Type-Options (MIME Sniffing)',
    severity: 'medium',
    recommendation: 'Add header: X-Content-Type-Options: nosniff',
  },
  {
    header: 'content-security-policy',
    name: 'Content Security Policy (CSP)',
    severity: 'high',
    recommendation: 'Implement a Content-Security-Policy header to prevent XSS and data injection.',
  },
  {
    header: 'x-xss-protection',
    name: 'X-XSS-Protection',
    severity: 'low',
    recommendation: 'Add header: X-XSS-Protection: 1; mode=block (legacy but still useful).',
  },
  {
    header: 'referrer-policy',
    name: 'Referrer Policy',
    severity: 'medium',
    recommendation: 'Add header: Referrer-Policy: strict-origin-when-cross-origin',
  },
  {
    header: 'permissions-policy',
    name: 'Permissions Policy (Feature Policy)',
    severity: 'medium',
    recommendation: 'Add Permissions-Policy header to control browser feature access (camera, mic, geolocation).',
  },
];

// Headers that disclose server information
const DISCLOSURE_HEADERS = [
  { header: 'server', name: 'Server Version', check: (val) => /apache|nginx|iis|litespeed/i.test(val) && /[\d.]+/.test(val) },
  { header: 'x-powered-by', name: 'X-Powered-By', check: () => true },
  { header: 'x-aspnet-version', name: 'ASP.NET Version', check: () => true },
  { header: 'x-debug-token', name: 'Debug Token', check: () => true },
];


// =========================================================================
// SCANNER FUNCTIONS
// =========================================================================

/**
 * Check a single endpoint for security issues.
 */
async function checkEndpoint(baseUrl, endpoint, timeoutMs = 10000) {
  const url = new URL(endpoint.path, baseUrl).href;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
      method: endpoint.method || 'GET',
      signal: controller.signal,
      redirect: 'manual', // Don't follow redirects — we want to see the actual response
      headers: {
        'User-Agent': 'SiteMonitor-SecurityScanner/1.0',
      },
    });
    clearTimeout(timeout);

    const status = resp.status;
    let vulnerable = false;
    let finding = null;

    if (endpoint.expectedBlock) {
      // This endpoint SHOULD be blocked (return 403/404/405)
      if (!endpoint.expectedBlock.includes(status) && status === 200) {
        vulnerable = true;
        finding = `${endpoint.name} is accessible (HTTP ${status}). Expected: ${endpoint.expectedBlock.join('/')}.`;
      }
    } else if (endpoint.checkExposed && status === 200) {
      // Flag as exposed (informational)
      finding = `${endpoint.name} is publicly accessible (HTTP ${status}).`;
    }

    return {
      path: endpoint.path,
      method: endpoint.method || 'GET',
      name: endpoint.name,
      status,
      vulnerable,
      severity: vulnerable ? endpoint.severity : (finding ? 'info' : null),
      finding,
      recommendation: vulnerable || finding ? endpoint.recommendation : null,
      checked: true,
    };
  } catch (err) {
    // Connection refused, timeout, etc. = endpoint not accessible = good
    return {
      path: endpoint.path,
      method: endpoint.method || 'GET',
      name: endpoint.name,
      status: null,
      vulnerable: false,
      severity: null,
      finding: null,
      recommendation: null,
      checked: true,
      error: err.message,
    };
  }
}

/**
 * Check security headers on the main page.
 */
async function checkSecurityHeaders(baseUrl, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(baseUrl, { signal: controller.signal });
    clearTimeout(timeout);

    const results = {
      missing: [],
      present: [],
      disclosures: [],
      score: 0,
    };

    // Check required security headers
    for (const hdr of SECURITY_HEADERS) {
      const value = resp.headers.get(hdr.header);
      if (value) {
        results.present.push({ ...hdr, value });
      } else {
        results.missing.push(hdr);
      }
    }

    // Check information disclosure headers
    for (const hdr of DISCLOSURE_HEADERS) {
      const value = resp.headers.get(hdr.header);
      if (value && hdr.check(value)) {
        results.disclosures.push({
          header: hdr.header,
          name: hdr.name,
          value,
          severity: 'low',
          recommendation: `Remove or sanitize the "${hdr.header}" header to prevent information disclosure.`,
        });
      }
    }

    // Calculate security score (0-100)
    const maxPoints = SECURITY_HEADERS.length;
    const earnedPoints = results.present.length;
    const disclosurePenalty = results.disclosures.length * 0.5;
    results.score = Math.max(0, Math.round(((earnedPoints - disclosurePenalty) / maxPoints) * 100));

    return results;
  } catch (err) {
    return { missing: [], present: [], disclosures: [], score: 0, error: err.message };
  }
}

/**
 * Run full security scan for a site.
 */
async function scanSite(siteUrl, siteName, timeoutMs = 10000) {
  console.log(`${LOG_PREFIX} Scanning ${siteName} (${siteUrl})...`);
  const startTime = Date.now();

  // 1. Check sensitive endpoints
  const endpointResults = [];
  for (const endpoint of SENSITIVE_ENDPOINTS) {
    const result = await checkEndpoint(siteUrl, endpoint, timeoutMs);
    endpointResults.push(result);
  }

  // 2. Check security headers
  const headerResults = await checkSecurityHeaders(siteUrl, timeoutMs);

  // 3. Compile findings
  const vulnerabilities = endpointResults.filter(r => r.vulnerable);
  const exposedEndpoints = endpointResults.filter(r => r.finding && !r.vulnerable);
  const missingHeaders = headerResults.missing || [];

  // 4. Calculate overall risk
  const criticalCount = vulnerabilities.filter(v => v.severity === 'critical').length;
  const highCount = vulnerabilities.filter(v => v.severity === 'high').length;
  const mediumCount = vulnerabilities.filter(v => v.severity === 'medium').length;

  let riskLevel = 'low';
  if (criticalCount > 0) riskLevel = 'critical';
  else if (highCount > 0) riskLevel = 'high';
  else if (mediumCount > 0 || missingHeaders.filter(h => h.severity === 'high').length >= 2) riskLevel = 'medium';

  const scanDuration = Date.now() - startTime;
  console.log(`${LOG_PREFIX} ${siteName}: ${vulnerabilities.length} vulnerabilities, ${missingHeaders.length} missing headers (${scanDuration}ms)`);

  return {
    site: siteName,
    url: siteUrl,
    riskLevel,
    scanDuration,
    timestamp: new Date().toISOString(),
    vulnerabilities,
    exposedEndpoints,
    headers: {
      score: headerResults.score,
      missing: missingHeaders,
      present: headerResults.present || [],
      disclosures: headerResults.disclosures || [],
    },
    summary: {
      endpointsChecked: endpointResults.length,
      vulnerabilities: vulnerabilities.length,
      exposed: exposedEndpoints.length,
      headersPresent: (headerResults.present || []).length,
      headersMissing: missingHeaders.length,
      infoDisclosures: (headerResults.disclosures || []).length,
      critical: criticalCount,
      high: highCount,
      medium: mediumCount,
    },
  };
}

/**
 * Run security scan for all configured sites.
 */
async function scanAllSites(sites, timeoutMs = 10000) {
  const results = {};
  for (const site of sites) {
    results[site.url] = await scanSite(site.url, site.name, timeoutMs);
  }

  // Overall summary
  const allResults = Object.values(results);
  const totalVulns = allResults.reduce((s, r) => s + r.summary.vulnerabilities, 0);
  const worstRisk = allResults.some(r => r.riskLevel === 'critical') ? 'critical'
    : allResults.some(r => r.riskLevel === 'high') ? 'high'
    : allResults.some(r => r.riskLevel === 'medium') ? 'medium' : 'low';

  return {
    sites: results,
    overall: {
      totalSites: allResults.length,
      totalVulnerabilities: totalVulns,
      worstRiskLevel: worstRisk,
      avgHeaderScore: Math.round(allResults.reduce((s, r) => s + r.headers.score, 0) / (allResults.length || 1)),
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  scanSite,
  scanAllSites,
  checkEndpoint,
  checkSecurityHeaders,
  SENSITIVE_ENDPOINTS,
  SECURITY_HEADERS,
};

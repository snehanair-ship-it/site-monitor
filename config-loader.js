/**
 * Loads and validates config.yml, merging with environment overrides.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.yml');

let _config = null;

function loadConfig() {
  if (_config) return _config;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = yaml.load(raw);

  // Apply environment overrides for backwards compat
  if (process.env.SITES && !config.sites?.length) {
    config.sites = process.env.SITES.split(',').map(item => {
      const [name, url, region] = item.split('|').map(t => t?.trim());
      return url ? {
        name: name || url,
        url,
        region: region || 'global',
        team: Object.keys(config.teams || {})[0] || 'default',
        sla_target: config.global?.default_sla_target || 99.9,
        check_endpoints: [{ path: '/', method: 'GET', expected_status: 200 }],
        auth: null,
        tags: [],
        vitals_enabled: true,
      } : null;
    }).filter(Boolean);
  }

  // Resolve auth credentials from env
  for (const site of config.sites || []) {
    if (site.auth) {
      site.auth._resolved = resolveAuth(site.auth);
    }
  }

  _config = config;
  return config;
}

function resolveAuth(auth) {
  if (!auth || !auth.type) return null;

  switch (auth.type) {
    case 'bearer':
      return {
        type: 'bearer',
        token: process.env[auth.token_env] || '',
      };
    case 'basic':
      return {
        type: 'basic',
        username: process.env[auth.username_env] || '',
        password: process.env[auth.password_env] || '',
      };
    case 'header':
      return {
        type: 'header',
        headerName: auth.header_name,
        headerValue: process.env[auth.header_value_env] || '',
      };
    default:
      return null;
  }
}

function getAuthHeaders(site) {
  const auth = site.auth?._resolved;
  if (!auth) return {};

  switch (auth.type) {
    case 'bearer':
      return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
    case 'basic': {
      const creds = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return creds !== 'Og==' ? { Authorization: `Basic ${creds}` } : {};
    }
    case 'header':
      return auth.headerValue ? { [auth.headerName]: auth.headerValue } : {};
    default:
      return {};
  }
}

function getSitesForTeam(teamId) {
  const config = loadConfig();
  return (config.sites || []).filter(s => s.team === teamId);
}

function getTeam(teamId) {
  const config = loadConfig();
  return config.teams?.[teamId] || null;
}

function getTeamForSite(site) {
  const config = loadConfig();
  return config.teams?.[site.team] || null;
}

function getAllTeams() {
  const config = loadConfig();
  return config.teams || {};
}

function getRegions() {
  const config = loadConfig();
  return config.regions || {};
}

function getGlobal() {
  const config = loadConfig();
  return config.global || {};
}

function getThresholds() {
  const config = loadConfig();
  return config.thresholds || { LCP: 2500, FCP: 1800, CLS: 0.1, TBT: 300 };
}

function getIPBlockConfig() {
  const config = loadConfig();
  return config.ip_block_detection || { enabled: false };
}

// Reset cached config (useful for testing)
function resetConfig() {
  _config = null;
}

module.exports = {
  loadConfig,
  getAuthHeaders,
  getSitesForTeam,
  getTeam,
  getTeamForSite,
  getAllTeams,
  getRegions,
  getGlobal,
  getThresholds,
  getIPBlockConfig,
  resetConfig,
};

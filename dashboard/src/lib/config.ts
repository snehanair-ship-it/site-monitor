import fs from "fs";
import path from "path";
import yaml from "js-yaml";

const CONFIG_PATH = path.join(process.cwd(), "..", "config.yml");
const DATA_PATH = path.join(process.cwd(), "..", "data", "uptime-data.json");

export interface SiteConfig {
  name: string;
  url: string;
  region: string;
  team: string;
  sla_target: number;
  check_endpoints: { path: string; method: string; expected_status: number }[];
  auth: null | Record<string, unknown>;
  tags: string[];
  vitals_enabled: boolean;
}

export interface TeamConfig {
  name: string;
  members: { name: string; email: string; role: string; escalation_level: number }[];
  slack_webhook: string;
  escalation: {
    level_1_after_minutes: number;
    level_2_after_minutes: number;
    level_3_after_minutes: number;
  };
}

export interface Config {
  global: Record<string, unknown>;
  teams: Record<string, TeamConfig>;
  sites: SiteConfig[];
  regions: Record<string, unknown>;
  ip_block_detection: Record<string, unknown>;
  thresholds: Record<string, number>;
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      global: { default_sla_target: 99.9, check_interval_minutes: 5 },
      teams: {},
      sites: [],
      regions: {},
      ip_block_detection: { enabled: true },
      thresholds: { LCP: 2500, FCP: 1800, CLS: 0.1, TBT: 300 },
    };
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return yaml.load(raw) as Config;
}

export function saveConfig(config: Config): void {
  const raw = yaml.dump(config, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(CONFIG_PATH, raw, "utf8");
}

export function loadUptimeData(): Record<string, unknown> {
  if (!fs.existsSync(DATA_PATH)) {
    return { sites: {}, regionChecks: {}, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { sites: {}, regionChecks: {}, lastUpdated: null };
  }
}

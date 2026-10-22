import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { BridgeConfig, AllowedScript } from '../../lib/host-bridge/types';
import { DEFAULT_PM2_ALLOWLIST, DEFAULT_SCRIPT_ALLOWLIST } from '../../lib/host-bridge/types';

const DEVFLOW_HOME = process.env.DEVFLOW_HOME || join(__dirname, '..', '..');
const CONFIG_PATH = join(DEVFLOW_HOME, 'config', 'host-bridge.json');

const DEFAULTS: BridgeConfig = {
  port: 3001,
  host: '127.0.0.1',
  authToken: process.env.HOST_BRIDGE_TOKEN || '',
  pm2Allowlist: DEFAULT_PM2_ALLOWLIST,
  scriptAllowlist: DEFAULT_SCRIPT_ALLOWLIST,
  rateLimit: {
    pm2: 60,
    pty: 30,
    script: 10,
  },
  maxPtySessions: 20,
  auditRetentionDays: 7,
};

export function loadConfig(): BridgeConfig {
  let fileConfig: Partial<BridgeConfig> = {};

  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      console.log(`[host-bridge] Config loaded from ${CONFIG_PATH}`);
    } catch (e) {
      console.error(`[host-bridge] Failed to parse config: ${e}`);
    }
  } else {
    console.log(`[host-bridge] No config file found, using defaults`);
  }

  const config: BridgeConfig = {
    ...DEFAULTS,
    ...fileConfig,
    // Enforce localhost binding — never allow override
    host: '127.0.0.1',
    rateLimit: { ...DEFAULTS.rateLimit, ...fileConfig.rateLimit },
  };

  // Auth token from env takes priority over config file
  if (process.env.HOST_BRIDGE_TOKEN) {
    config.authToken = process.env.HOST_BRIDGE_TOKEN;
  }

  if (!config.authToken) {
    console.error('[host-bridge] WARNING: No auth token set. Set HOST_BRIDGE_TOKEN env var.');
    console.error('[host-bridge] All authenticated requests will be rejected.');
  }

  return config;
}

export { DEVFLOW_HOME };

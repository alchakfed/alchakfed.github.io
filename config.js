const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  port: 3000,
  auto_scrape: true,
  max_manual_runs_per_hour: 5,
  webhooks: [],
  discord_bot_token: '',
  discord_guild_id: '',
  discord_servers: [],
  sync_shared_secret: '',
  upkeep_channel_id: '',
  default_watched_nations: [],
  nation_role_ids: {},
  ping_role_id: '',
  last_run: null
};

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in environment variable ${name}: ${error.message}`);
  }
}

function readEnvConfig() {
  const envConfig = parseJsonEnv('CONFIG_JSON');

  if (process.env.DISCORD_BOT_TOKEN) {
    envConfig.discord_bot_token = process.env.DISCORD_BOT_TOKEN;
  }

  if (process.env.DISCORD_GUILD_ID) {
    envConfig.discord_guild_id = process.env.DISCORD_GUILD_ID;
  }

  if (process.env.SYNC_SHARED_SECRET) {
    envConfig.sync_shared_secret = process.env.SYNC_SHARED_SECRET;
  }

  if (process.env.WEBHOOKS_JSON) {
    envConfig.webhooks = parseJsonEnv('WEBHOOKS_JSON');
  }

  if (process.env.PORT) {
    envConfig.port = Number(process.env.PORT);
  }

  if (process.env.AUTO_SCRAPE) {
    envConfig.auto_scrape = process.env.AUTO_SCRAPE === 'true';
  }

  if (process.env.MAX_MANUAL_RUNS_PER_HOUR) {
    envConfig.max_manual_runs_per_hour = Number(process.env.MAX_MANUAL_RUNS_PER_HOUR);
  }

  if (process.env.LAST_RUN) {
    envConfig.last_run = process.env.LAST_RUN;
  }

  return envConfig;
}

function loadConfig() {
  return {
    ...DEFAULT_CONFIG,
    ...readJsonFile(CONFIG_PATH),
    ...readEnvConfig()
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig
};

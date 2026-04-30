const fs = require('fs');
const path = require('path');

// Load .env file dynamically so we don't hardcode secrets
// Uses plain string parsing to avoid requiring the 'dotenv' npm module
let envConfig = {};
try {
  const envPath = path.resolve(__dirname, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    envConfig[key] = value;
  });
} catch (e) {
  console.warn("Could not load .env file, relying on system environment variables.");
}

module.exports = {
  apps: [
    {
      name: "dialog-api",
      script: "artifacts/api-server/dist/index.mjs",
      cwd: "/var/www/noeticminds__usr/data/www/dialog.noeticminds.com/Dialog",
      node_args: "--enable-source-maps",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        PORT: envConfig.PORT || "3002",
        NODE_ENV: "production",
        // Map DATABASE_URI to DATABASE_URL since the code expects DATABASE_URL
        DATABASE_URL: envConfig.DATABASE_URI || envConfig.DATABASE_URL,
        DATABASE_SSL: envConfig.DATABASE_SSL || "true",
        JWT_SECRET: envConfig.JWT_SECRET,
        OPENAI_API_KEY: envConfig.OPENAI_API_KEY,
      },
    },
  ],
};

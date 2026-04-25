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
        PORT: "3002",
        NODE_ENV: "production",
        // Database
        DATABASE_URL: "postgresql://user:pass@localhost:5432/dbname",
        DATABASE_SSL: "true",
        // Auth — generate with: openssl rand -hex 64
        JWT_SECRET: "REPLACE_WITH_64_CHAR_HEX_SECRET",
        // AI — optional, enables chat widget & AI features
        // Use either Replit integration vars OR a plain OpenAI key:
        OPENAI_API_KEY: "sk-...",
      },
    },
  ],
};

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
        DATABASE_SSL: "true",
      },
    },
  ],
};

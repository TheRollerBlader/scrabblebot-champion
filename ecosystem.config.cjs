module.exports = {
  apps: [
    {
      name: "scrabblebot-agent",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 1500,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        STDB_HOST: "https://maincloud.spacetimedb.com",
        STDB_DB: "scrabblebot"
      }
    },
    {
      name: "scrabblebot-dashboard",
      script: "node_modules/.bin/tsx",
      args: "src/dashboard.ts",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      restart_delay: 1500,
      env: {
        NODE_ENV: "production",
        PORT: "4320"
      }
    }
  ]
};

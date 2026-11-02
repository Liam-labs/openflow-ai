// ecosystem.config.template.js — OpenFlow PM2 configuration template
//
// Copy this file to ecosystem.config.js and customise for your environment.
// ecosystem.config.js is gitignored — your local copy won't be overwritten.
//
// Required env var: DEVFLOW_HOME (set in ~/.secrets or your shell profile)

const DEVFLOW_HOME = process.env.DEVFLOW_HOME || __dirname;

module.exports = {
  apps: [
    {
      name: 'openflow',
      script: 'npm',
      args: 'start',            // next start on 127.0.0.1 (DEVFLOW_BIND_HOST changes that); run `npm run build` first
      cwd: DEVFLOW_HOME,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
      stop_exit_codes: [78],   // 78 = refused to start: reachable from other computers with no sign-in password (lib/exposure-guard.ts); do not loop
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        TURBOPACK: '',  // MUST be empty — TURBOPACK=1 breaks Next.js builds
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: `${DEVFLOW_HOME}/logs/error.log`,
      out_file: `${DEVFLOW_HOME}/logs/output.log`,
      merge_logs: true,
      log_type: 'json',
    },
    // Add your own services below. Examples:
    //
    // {
    //   name: 'my-tunnel',
    //   script: 'cloudflared',
    //   args: 'tunnel run --url http://localhost:8080 my-tunnel',
    //   autorestart: true,
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: `${DEVFLOW_HOME}/logs/my-tunnel-error.log`,
    //   out_file: `${DEVFLOW_HOME}/logs/my-tunnel-output.log`,
    // },
  ],
};

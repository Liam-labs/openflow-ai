import express from 'express';
import { authMiddleware } from './middleware/auth';
import { auditMiddleware, getRecentAuditEntries, cleanOldLogs } from './middleware/audit';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { pm2Router } from './routes/pm2';
import { ptyRouter } from './routes/pty';
import { scriptRouter } from './routes/script';
import { loadConfig } from './config';
import type { HealthResponse, BridgeResponse, AuditRecentResponse } from '../../lib/host-bridge/types';

const config = loadConfig();
const app = express();

app.use(express.json());

// Health endpoint — no auth required
app.get('/health', (_req, res) => {
  const response: HealthResponse = {
    status: 'ok',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    startedAt: startedAt.toISOString(),
  };
  res.json(response);
});

// Auth required for all other routes
app.use(authMiddleware(config.authToken));

// Audit logging on all authenticated routes
app.use(auditMiddleware());

// Rate limiting
app.use('/pm2', rateLimitMiddleware(config.rateLimit.pm2));
app.use('/pty', rateLimitMiddleware(config.rateLimit.pty));
app.use('/script', rateLimitMiddleware(config.rateLimit.script));

// Routes
app.use('/pm2', pm2Router(config));
app.use('/pty', ptyRouter(config));
app.use('/script', scriptRouter(config));

// Audit endpoint
app.get('/audit/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const entries = getRecentAuditEntries(limit);
  const response: BridgeResponse<AuditRecentResponse> = {
    success: true,
    data: { entries, total: entries.length },
    timestamp: new Date().toISOString(),
  };
  res.json(response);
});

const startedAt = new Date();

const server = app.listen(config.port, config.host, () => {
  console.log(`[host-bridge] Running on ${config.host}:${config.port}`);
  console.log(`[host-bridge] PM2 allowlist: ${config.pm2Allowlist.length} patterns`);
  console.log(`[host-bridge] Script allowlist: ${config.scriptAllowlist.length} scripts`);
  console.log(`[host-bridge] Max PTY sessions: ${config.maxPtySessions}`);
  console.log(`[host-bridge] Audit logs: ${process.env.DEVFLOW_HOME || '.'}/logs/host-bridge/`);

  // Clean old audit logs on startup
  cleanOldLogs(config.auditRetentionDays);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[host-bridge] ${signal} received. Shutting down...`);
  server.close(() => {
    console.log('[host-bridge] Server closed.');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

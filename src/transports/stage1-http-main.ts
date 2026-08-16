#!/usr/bin/env node
import { createStage1HttpServer } from './stage1-http.js';
import { validateStage1Startup } from '../stage1/startup.js';

try {
  const config = validateStage1Startup();
  const server = createStage1HttpServer({ config });
  server.listen(config.port, config.host, () => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'stage1_http_started',
      host: config.host,
      port: config.port,
    }));
  });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'stage1_startup_failed',
    error: message,
  }));
  process.exitCode = 1;
}

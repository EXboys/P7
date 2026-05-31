#!/usr/bin/env bun
import "../src/llm-env.ts";
import { loadServerConfig, saveServerConfig } from "./config.ts";
import { createDashboard } from "./dashboard.ts";
import { startScheduler } from "./scheduler.ts";
import { startPrReviewScheduler } from "./pr-review-scheduler.ts";
import { startWorker } from "./queue/worker.ts";
import { audit } from "./audit.ts";

let cfg = loadServerConfig();

const app = createDashboard(
  () => cfg,
  (c) => {
    cfg = c;
  },
);

const stopScheduler = startScheduler(cfg);
const stopPrReviewScheduler = startPrReviewScheduler(cfg);
const stopWorker = startWorker(cfg);

audit("server.started", { port: cfg.port, host: cfg.bind_host });

const port = Number(process.env.PORT ?? cfg.port);
const hostname = process.env.HOST ?? cfg.bind_host;

const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
});

console.log(`P7 server http://${cfg.bind_host}:${server.port}`);

process.on("SIGINT", () => {
  stopScheduler();
  stopPrReviewScheduler();
  stopWorker();
  process.exit(0);
});

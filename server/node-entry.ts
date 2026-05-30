import { serve } from "@hono/node-server";
import { loadServerConfig, saveServerConfig } from "./config.ts";
import { createDashboard } from "./dashboard.ts";
import { audit } from "./audit.ts";

/**
 * Node/tsx entry for the management dashboard. The job worker and scheduler
 * require the Bun runtime (bun:sqlite, Bun.spawn); run `bun run server/index.ts`
 * for the full loop. This entry serves the admin + settings backend so it can
 * be used without bun installed.
 */

let cfg = loadServerConfig();

const app = createDashboard(
  () => cfg,
  (next) => {
    cfg = next;
  },
);

const port = Number(process.env.PORT ?? cfg.port);
const hostname = process.env.HOST ?? cfg.bind_host;

audit("admin.started", { port, host: hostname, runtime: "node" });

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`P7 admin console: http://${hostname}:${info.port}`);
});

import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

type SimulationJob = { process: ChildProcess; directory: string };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const sendJson = (response: import("node:http").ServerResponse, status: number, value: unknown) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
};

const readRequestBody = (request: import("node:http").IncomingMessage) => new Promise<unknown>((resolveBody, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 5_000_000) reject(new Error("Simulation request is too large"));
  });
  request.on("end", () => {
    try {
      resolveBody(JSON.parse(body || "{}"));
    } catch {
      reject(new Error("Invalid JSON request"));
    }
  });
  request.on("error", reject);
});

const solweigApi = (): Plugin => ({
  name: "shade-local-solweig-api",
  configureServer(server) {
    const guiRoot = process.cwd();
    const projectRoot = resolve(guiRoot, "..");
    const runsRoot = resolve(projectRoot, "runs/gui_solweig");
    const python = resolve(projectRoot, ".venv/bin/python");
    const runner = resolve(guiRoot, "scripts/run_gui_solweig.py");
    const weatherFiles = ["baseline", "warm_2c", "humid_warm_2c", "warm_4c"]
      .map((scenario) => resolve(projectRoot, `data/weather/scenarios/boston_${scenario}.epw`));
    const aoi = resolve(projectRoot, "data/aoi/chinatown/dsm.tif");
    const jobs = new Map<string, SimulationJob>();
    let activeJobId: string | null = null;

    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/solweig")) {
        next();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/solweig/availability") {
        const ready = existsSync(python) && existsSync(runner) && weatherFiles.every(existsSync) && existsSync(aoi);
        sendJson(response, 200, {
          ready,
          active_job_id: activeJobId,
          checks: {
            virtual_environment: existsSync(python),
            runner: existsSync(runner),
            weather_scenarios: weatherFiles.every(existsSync),
            chinatown_inputs: existsSync(aoi),
          },
        });
        return;
      }

      if (request.method === "POST" && ["/api/solweig/run", "/api/solweig/baseline"].includes(url.pathname)) {
        const baselineOnly = url.pathname === "/api/solweig/baseline";
        const mode = baselineOnly ? "baseline" : "comparison";
        if (activeJobId) {
          sendJson(response, 409, { error: "A SOLWEIG simulation is already running", id: activeJobId });
          return;
        }
        if (![python, runner, aoi].every(existsSync) || !weatherFiles.every(existsSync)) {
          sendJson(response, 503, { error: "The local SOLWEIG environment, weather, or Chinatown inputs are missing" });
          return;
        }
        try {
          const body = await readRequestBody(request) as { trees?: unknown[]; reflective_pavement?: { width?: number; height?: number; count?: number; data?: string }; depaved_pavement?: { width?: number; height?: number; count?: number; data?: string }; shade_canopy?: { width?: number; height?: number; count?: number; data?: string }; solar_canopy?: { width?: number; height?: number; count?: number; data?: string }; cool_roof?: { width?: number; height?: number; count?: number; data?: string }; green_roof?: { width?: number; height?: number; count?: number; data?: string }; scenario?: string; date?: string; hour?: number };
          const treeCount = Array.isArray(body.trees) ? body.trees.length : 0;
          const reflectiveCount = Number(body.reflective_pavement?.count ?? 0);
          const coolRoofCount = Number(body.cool_roof?.count ?? 0);
          const greenRoofCount = Number(body.green_roof?.count ?? 0);
          const depavedCount = Number(body.depaved_pavement?.count ?? 0);
          const shadeCanopyCount = Number(body.shade_canopy?.count ?? 0);
          const solarCanopyCount = Number(body.solar_canopy?.count ?? 0);
          if (!baselineOnly && treeCount < 1 && reflectiveCount < 1 && coolRoofCount < 1 && greenRoofCount < 1 && depavedCount < 1 && shadeCanopyCount < 1 && solarCanopyCount < 1) {
            sendJson(response, 400, { error: "A simulation requires at least one tree, pavement treatment, or roof treatment" });
            return;
          }
          const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
          const directory = resolve(runsRoot, id);
          mkdirSync(directory, { recursive: true });
          const payload = {
            id,
            mode,
            trees: baselineOnly ? [] : body.trees,
            reflective_pavement: baselineOnly ? null : body.reflective_pavement,
            cool_roof: baselineOnly ? null : body.cool_roof,
            green_roof: baselineOnly ? null : body.green_roof,
            depaved_pavement: baselineOnly ? null : body.depaved_pavement,
            shade_canopy: baselineOnly ? null : body.shade_canopy,
            solar_canopy: baselineOnly ? null : body.solar_canopy,
            scenario: body.scenario ?? "baseline",
            date: body.date ?? "07-27",
            hour: Number(body.hour ?? 15),
          };
          const requestPath = resolve(directory, "request.json");
          writeFileSync(requestPath, `${JSON.stringify(payload, null, 2)}\n`);
          writeFileSync(resolve(directory, "status.json"), `${JSON.stringify({ id, mode, state: "queued", stage: baselineOnly ? "Waiting to build baseline" : "Waiting to start", progress: 0 }, null, 2)}\n`);
          const log = createWriteStream(resolve(directory, "runner.log"), { flags: "a" });
          const child = spawn(python, [runner, "--request", requestPath], {
            cwd: projectRoot,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child.stdout?.pipe(log);
          child.stderr?.pipe(log);
          jobs.set(id, { process: child, directory });
          activeJobId = id;
          child.on("close", (code, signal) => {
            log.end();
            jobs.delete(id);
            if (activeJobId === id) activeJobId = null;
            const statusPath = resolve(directory, "status.json");
            try {
              const status = readJson(statusPath);
              if (!["complete", "failed", "cancelled"].includes(status.state)) {
                writeFileSync(statusPath, `${JSON.stringify({ ...status, state: "failed", stage: "Simulation stopped", progress: 100, error: signal ? `Stopped by ${signal}` : `Runner exited with code ${code}` }, null, 2)}\n`);
              }
            } catch {
              writeFileSync(statusPath, `${JSON.stringify({ id, state: "failed", stage: "Simulation stopped", progress: 100, error: `Runner exited with code ${code}` }, null, 2)}\n`);
            }
          });
          sendJson(response, 202, { id, mode, state: "queued" });
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "Unable to start simulation" });
        }
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/solweig\/status\/([a-zA-Z0-9-]+)$/);
      if (request.method === "GET" && statusMatch) {
        const statusPath = resolve(runsRoot, statusMatch[1], "status.json");
        if (!existsSync(statusPath)) {
          sendJson(response, 404, { error: "Simulation job not found" });
          return;
        }
        sendJson(response, 200, readJson(statusPath));
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/solweig\/run\/([a-zA-Z0-9-]+)$/);
      if (request.method === "DELETE" && cancelMatch) {
        const job = jobs.get(cancelMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Running simulation job not found" });
          return;
        }
        job.process.kill("SIGTERM");
        writeFileSync(resolve(job.directory, "status.json"), `${JSON.stringify({ id: cancelMatch[1], state: "cancelled", stage: "Cancelled by user", progress: 100 }, null, 2)}\n`);
        sendJson(response, 200, { id: cancelMatch[1], state: "cancelled" });
        return;
      }

      sendJson(response, 404, { error: "Unknown SOLWEIG API endpoint" });
    });

    server.httpServer?.once("close", () => {
      for (const job of jobs.values()) job.process.kill("SIGTERM");
    });
  },
});

export default defineConfig({
  plugins: [react(), solweigApi()],
});

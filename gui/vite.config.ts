import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    const configuredAoIs = readJson(resolve(projectRoot, "config/aois.json")).aois as Record<string, unknown>;
    const validAoi = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(configuredAoIs, value);
    const aoiSource = (aoi: string) => {
      const manifestPath = resolve(guiRoot, `public/data/${aoi}/manifest.json`);
      if (!existsSync(manifestPath)) return resolve(projectRoot, `data/aoi/${aoi}`);
      const sourceDirectory = readJson(manifestPath).source_directory as string | undefined;
      return sourceDirectory ? resolve(projectRoot, sourceDirectory) : resolve(projectRoot, `data/aoi/${aoi}`);
    };
    const aoiReady = (aoi: string) => ["aoi.json", "dsm.tif", "dem.tif", "cdsm.tif", "landcover.tif"]
      .every((file) => existsSync(resolve(aoiSource(aoi), file)));
    const jobs = new Map<string, SimulationJob>();
    let activeJobId: string | null = null;

    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/solweig")) {
        next();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/solweig/availability") {
        const requestedAoi = url.searchParams.get("aoi") ?? "chinatown";
        const knownAoi = validAoi(requestedAoi);
        const ready = existsSync(python) && existsSync(runner) && weatherFiles.every(existsSync) && knownAoi && aoiReady(requestedAoi);
        sendJson(response, 200, {
          ready,
          active_job_id: activeJobId,
          checks: {
            virtual_environment: existsSync(python),
            runner: existsSync(runner),
            weather_scenarios: weatherFiles.every(existsSync),
            study_area_inputs: knownAoi && aoiReady(requestedAoi),
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
        try {
          const body = await readRequestBody(request) as { aoi?: string; trees?: unknown[]; reflective_pavement?: { width?: number; height?: number; count?: number; data?: string }; depaved_pavement?: { width?: number; height?: number; count?: number; data?: string }; shade_canopy?: { width?: number; height?: number; count?: number; data?: string }; solar_canopy?: { width?: number; height?: number; count?: number; data?: string }; cool_roof?: { width?: number; height?: number; count?: number; data?: string }; green_roof?: { width?: number; height?: number; count?: number; data?: string }; scenario?: string; date?: string; hour?: number };
          const requestedAoi = body.aoi ?? "chinatown";
          if (!validAoi(requestedAoi) || !aoiReady(requestedAoi)) {
            sendJson(response, 503, { error: "The selected study-area inputs are missing" });
            return;
          }
          if (![python, runner].every(existsSync) || !weatherFiles.every(existsSync)) {
            sendJson(response, 503, { error: "The local SOLWEIG environment or weather inputs are missing" });
            return;
          }
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
            aoi: requestedAoi,
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

const scoringApi = (): Plugin => ({
  name: "shade-local-policy-scoring-api",
  configureServer(server) {
    const guiRoot = process.cwd();
    const projectRoot = resolve(guiRoot, "..");
    const runsRoot = resolve(projectRoot, "runs/gui_scores");
    const python = resolve(projectRoot, ".venv/bin/python");
    const runner = resolve(guiRoot, "scripts/run_gui_score.py");
    const scorer = resolve(projectRoot, "scripts/score_policy.py");
    const policy = resolve(guiRoot, "scripts/gui_policy.py");
    const aoiFileNames = ["aoi.json", "dsm.tif", "dem.tif", "cdsm.tif", "landcover.tif", "heat_ta3pm.tif", "heat_ta3am.tif", "heat_uhii.tif", "heat_hours.tif"];
    const weatherFiles = ["baseline", "warm_2c", "humid_warm_2c", "warm_4c"]
      .map((scenario) => resolve(projectRoot, `data/weather/scenarios/boston_${scenario}.epw`));
    const vulnerability = resolve(projectRoot, "data/heat/climate_ready_social_vulnerability.geojson");
    const configuredAoIs = readJson(resolve(projectRoot, "config/aois.json")).aois as Record<string, unknown>;
    const validAoi = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(configuredAoIs, value);
    const aoiSource = (aoi: string) => {
      const manifestPath = resolve(guiRoot, `public/data/${aoi}/manifest.json`);
      if (!existsSync(manifestPath)) return resolve(projectRoot, `data/aoi/${aoi}`);
      const sourceDirectory = readJson(manifestPath).source_directory as string | undefined;
      return sourceDirectory ? resolve(projectRoot, sourceDirectory) : resolve(projectRoot, `data/aoi/${aoi}`);
    };
    const aoiFiles = (aoi: string) => aoiFileNames.map((file) => resolve(aoiSource(aoi), file));
    const jobs = new Map<string, SimulationJob>();
    let activeJobId: string | null = null;

    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/scoring")) {
        next();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/scoring/availability") {
        const requestedAoi = url.searchParams.get("aoi") ?? "chinatown";
        const knownAoi = validAoi(requestedAoi);
        const checks = {
          virtual_environment: existsSync(python),
          runner: existsSync(runner) && existsSync(scorer) && existsSync(policy),
          weather_scenarios: weatherFiles.every(existsSync),
          study_area_inputs: knownAoi && aoiFiles(requestedAoi).every(existsSync),
          vulnerability_data: existsSync(vulnerability),
        };
        sendJson(response, 200, {
          ready: Object.values(checks).every(Boolean),
          active_job_id: activeJobId,
          checks,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scoring/run") {
        if (activeJobId) {
          sendJson(response, 409, { error: "A policy score is already running", id: activeJobId });
          return;
        }
        try {
          const body = await readRequestBody(request) as {
            aoi?: string;
            trees?: unknown[];
            reflective_pavement?: { count?: number };
            depaved_pavement?: { count?: number };
            shade_canopy?: { count?: number };
            solar_canopy?: { count?: number };
            cool_roof?: { count?: number };
            green_roof?: { count?: number };
            scenario?: string;
            budget_usd?: number;
            layout_signature?: string;
          };
          const requestedAoi = body.aoi ?? "chinatown";
          if (!validAoi(requestedAoi) || !aoiFiles(requestedAoi).every(existsSync)) {
            sendJson(response, 503, { error: "The selected study-area policy inputs are missing" });
            return;
          }
          if (![python, runner, scorer, policy, vulnerability, ...weatherFiles].every(existsSync)) {
            sendJson(response, 503, { error: "The local scorer or weather inputs are missing" });
            return;
          }
          const interventionCount = (Array.isArray(body.trees) ? body.trees.length : 0)
            + Number(body.reflective_pavement?.count ?? 0)
            + Number(body.depaved_pavement?.count ?? 0)
            + Number(body.shade_canopy?.count ?? 0)
            + Number(body.solar_canopy?.count ?? 0)
            + Number(body.cool_roof?.count ?? 0)
            + Number(body.green_roof?.count ?? 0);
          if (interventionCount < 1) {
            sendJson(response, 400, { error: "Add at least one intervention before scoring the policy" });
            return;
          }
          const budget = Number(body.budget_usd ?? 500_000);
          if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000_000) {
            sendJson(response, 400, { error: "Scoring budget must be between $1 and $1 billion" });
            return;
          }
          const allowedScenarios = new Set(["baseline", "warm_2c", "humid_warm_2c", "warm_4c"]);
          if (!allowedScenarios.has(String(body.scenario ?? "baseline"))) {
            sendJson(response, 400, { error: "Unknown climate scenario" });
            return;
          }
          const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
          const directory = resolve(runsRoot, id);
          mkdirSync(directory, { recursive: true });
          const payload = { ...body, id, budget_usd: budget };
          const requestPath = resolve(directory, "request.json");
          writeFileSync(requestPath, `${JSON.stringify(payload, null, 2)}\n`);
          writeFileSync(resolve(directory, "status.json"), `${JSON.stringify({ id, state: "queued", stage: "Waiting to audit layout", progress: 0 }, null, 2)}\n`);
          const log = createWriteStream(resolve(directory, "api.log"), { flags: "a" });
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
                writeFileSync(statusPath, `${JSON.stringify({ ...status, state: "failed", stage: "Policy scoring stopped", progress: 100, error: signal ? `Stopped by ${signal}` : `Runner exited with code ${code}` }, null, 2)}\n`);
              }
            } catch {
              writeFileSync(statusPath, `${JSON.stringify({ id, state: "failed", stage: "Policy scoring stopped", progress: 100, error: `Runner exited with code ${code}` }, null, 2)}\n`);
            }
          });
          sendJson(response, 202, { id, state: "queued" });
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "Unable to start policy scoring" });
        }
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/scoring\/status\/([a-zA-Z0-9-]+)$/);
      if (request.method === "GET" && statusMatch) {
        const statusPath = resolve(runsRoot, statusMatch[1], "status.json");
        if (!existsSync(statusPath)) {
          sendJson(response, 404, { error: "Policy score job not found" });
          return;
        }
        sendJson(response, 200, readJson(statusPath));
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/scoring\/run\/([a-zA-Z0-9-]+)$/);
      if (request.method === "DELETE" && cancelMatch) {
        const job = jobs.get(cancelMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Running policy score job not found" });
          return;
        }
        job.process.kill("SIGTERM");
        writeFileSync(resolve(job.directory, "status.json"), `${JSON.stringify({ id: cancelMatch[1], state: "cancelled", stage: "Cancelled by user", progress: 100 }, null, 2)}\n`);
        sendJson(response, 200, { id: cancelMatch[1], state: "cancelled" });
        return;
      }

      sendJson(response, 404, { error: "Unknown policy scoring API endpoint" });
    });

    server.httpServer?.once("close", () => {
      for (const job of jobs.values()) job.process.kill("SIGTERM");
    });
  },
});

const autoresearchApi = (): Plugin => ({
  name: "shade-local-autoresearch-archive-api",
  configureServer(server) {
    const projectRoot = resolve(process.cwd(), "..");
    const runsRoot = resolve(projectRoot, "runs");
    const validRunId = (value: string) => /^[a-zA-Z0-9._-]+$/.test(value);

    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/autoresearch")) {
        next();
        return;
      }
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Autoresearch archives are read-only" });
        return;
      }

      if (url.pathname === "/api/autoresearch/runs") {
        const runs = existsSync(runsRoot)
          ? readdirSync(runsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && validRunId(entry.name) && existsSync(resolve(runsRoot, entry.name, "archive.json")))
            .map((entry) => {
              const archive = readJson(resolve(runsRoot, entry.name, "archive.json"));
              return {
                id: entry.name,
                state: archive.state,
                updated_utc: archive.updated_utc,
                run: archive.run,
                iteration_count: Array.isArray(archive.iterations) ? archive.iterations.length : 0,
                best_id: archive.summary?.best_id ?? null,
              };
            })
            .sort((left, right) => String(right.run?.started_utc ?? "").localeCompare(String(left.run?.started_utc ?? "")))
          : [];
        sendJson(response, 200, { schema_version: 1, runs });
        return;
      }

      const archiveMatch = url.pathname.match(/^\/api\/autoresearch\/runs\/([a-zA-Z0-9._-]+)\/archive$/);
      if (archiveMatch) {
        const archivePath = resolve(runsRoot, archiveMatch[1], "archive.json");
        if (!existsSync(archivePath)) {
          sendJson(response, 404, { error: "Autoresearch archive not found" });
          return;
        }
        sendJson(response, 200, readJson(archivePath));
        return;
      }

      const fileMatch = url.pathname.match(/^\/api\/autoresearch\/runs\/([a-zA-Z0-9._-]+)\/files\/(.+)$/);
      if (fileMatch) {
        const runDirectory = resolve(runsRoot, fileMatch[1]);
        const relative = decodeURIComponent(fileMatch[2]);
        const filePath = resolve(runDirectory, relative);
        if (!filePath.startsWith(`${runDirectory}/`) || !filePath.endsWith(".json") || !existsSync(filePath)) {
          sendJson(response, 404, { error: "Autoresearch JSON artifact not found" });
          return;
        }
        sendJson(response, 200, readJson(filePath));
        return;
      }

      sendJson(response, 404, { error: "Unknown autoresearch archive endpoint" });
    });
  },
});

export default defineConfig({
  plugins: [react(), solweigApi(), scoringApi(), autoresearchApi()],
});

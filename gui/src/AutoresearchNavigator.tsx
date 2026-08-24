import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitBranch,
  LoaderCircle,
  X,
} from "lucide-react";

export type ArchivedMask = {
  width: number;
  height: number;
  count: number;
  data: string;
};

export type ArchivedTree = {
  id: string;
  x: number;
  y: number;
  size: "small" | "medium";
  heightM: number;
  crownDiameterM: number;
};

export type ArchivedLayout = {
  schema_version: number;
  candidate_id: string;
  aoi: string;
  resolution_m: number;
  width: number;
  height: number;
  trees: ArchivedTree[];
  interventions: Record<string, ArchivedMask>;
};

type ObjectiveMap = Record<string, number | null | undefined>;

export type ArchiveIteration = {
  id: string;
  generation: number;
  parent_id?: string | null;
  inspiration_ids?: string[];
  policy_name?: string;
  description?: string;
  verdict?: "feasible" | "infeasible";
  fitness?: number | null;
  objectives?: ObjectiveMap | null;
  cell?: number[] | null;
  aois_scored?: string[];
  timestamp_utc?: string;
  layout_files?: Record<string, string>;
  score_files?: Record<string, string>;
};

export type Archive = {
  schema_version: number;
  state: "running" | "complete" | string;
  updated_utc?: string;
  run?: {
    id?: string;
    started_utc?: string;
    aois?: string[];
    scenarios?: string[];
    budget_usd_per_aoi?: number;
    budget_usd?: number;
    resolution_m?: number;
    model?: string;
  };
  iterations: ArchiveIteration[];
  summary?: { best_id?: string; [key: string]: unknown } | null;
};

type RunSummary = {
  id: string;
  state: string;
  updated_utc?: string;
  iteration_count: number;
  best_id?: string | null;
  run?: Archive["run"];
};

type Props = {
  activeAoi: string;
  onClose: () => void;
  onLayout: (layout: ArchivedLayout, iteration: ArchiveIteration, archive: Archive, runId: string) => void;
  onUnavailable: (iteration: ArchiveIteration | null, runId: string | null) => void;
  onCopy: () => void;
  onSelectAoi: (aoi: string) => void;
};

const RUN_STORAGE_KEY = "shade.autoresearch.run.v1";
const ITERATION_STORAGE_KEY = "shade.autoresearch.iteration.v1";

const OBJECTIVES: { key: string; label: string; color: string; format: (value: number) => string }[] = [
  { key: "heat_relief_c", label: "UTCI relief", color: "#287358", format: (value) => `${value.toFixed(3)}°C` },
  { key: "tmrt_relief_c", label: "MRT relief", color: "#3f6fa6", format: (value) => `${value.toFixed(3)}°C` },
  { key: "access_gain_pp", label: "Access gain", color: "#b57b2d", format: (value) => `${value.toFixed(2)} pp` },
  { key: "equity_ratio", label: "Equity ratio", color: "#8a5ca4", format: (value) => value.toFixed(3) },
  { key: "cobenefit_greened_pct", label: "Greened", color: "#678c45", format: (value) => `${value.toFixed(2)}%` },
  { key: "cost_efficiency_person_c_per_100k", label: "Cost efficiency", color: "#a55447", format: (value) => value.toFixed(2) },
];

const formatCost = (value: number | null | undefined) => value == null
  ? "Not available"
  : `$${Math.round(value).toLocaleString()}`;

const ProgressChart = ({ iterations, selectedId, onSelect }: {
  iterations: ArchiveIteration[];
  selectedId: string;
  onSelect: (id: string) => void;
}) => {
  const width = 620;
  const height = 112;
  const padding = 14;
  const values = iterations.map((iteration) => iteration.fitness ?? iteration.objectives?.heat_relief_c ?? 0);
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, minimum + 0.001);
  const x = (index: number) => iterations.length <= 1 ? width / 2 : padding + index * (width - padding * 2) / (iterations.length - 1);
  const y = (value: number) => height - padding - ((value - minimum) / (maximum - minimum)) * (height - padding * 2);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ");
  return (
    <div className="autoresearch-chart-wrap">
      <svg className="autoresearch-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Feasible policy fitness by iteration">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <path d={path} />
        {iterations.map((iteration, index) => (
          <circle
            key={iteration.id}
            className={iteration.id === selectedId ? "selected" : ""}
            cx={x(index)}
            cy={y(values[index])}
            r={iteration.id === selectedId ? 5.5 : 3.5}
            onClick={() => onSelect(iteration.id)}
          />
        ))}
      </svg>
      <div className="autoresearch-chart-label"><span>Earlier</span><strong>Overall heat-relief fitness</strong><span>Later</span></div>
    </div>
  );
};

const Sparkline = ({ values, color }: { values: (number | null | undefined)[]; color: string }) => {
  const finite = values.map((value) => value == null ? null : Number(value));
  const present = finite.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!present.length) return <span className="autoresearch-no-trend">no trend</span>;
  const min = Math.min(...present);
  const max = Math.max(...present, min + 1e-9);
  const x = (index: number) => finite.length <= 1 ? 32 : index * 64 / (finite.length - 1);
  const y = (value: number) => 14 - ((value - min) / (max - min)) * 12;
  let penUp = true;
  const path = finite.map((value, index) => {
    if (value === null || !Number.isFinite(value)) { penUp = true; return ""; }
    const command = penUp ? "M" : "L";
    penUp = false;
    return `${command}${x(index)},${y(value)}`;
  }).join(" ");
  return <svg className="autoresearch-sparkline" viewBox="0 0 64 16" aria-hidden="true"><path d={path} style={{ stroke: color }} /></svg>;
};

export default function AutoresearchNavigator({ activeAoi, onClose, onLayout, onUnavailable, onCopy, onSelectAoi }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(() => localStorage.getItem(RUN_STORAGE_KEY) ?? "");
  const [archive, setArchive] = useState<Archive | null>(null);
  const [selectedIterationId, setSelectedIterationId] = useState(() => localStorage.getItem(ITERATION_STORAGE_KEY) ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const deliveredLayoutKey = useRef("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/autoresearch/runs", { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to list autoresearch runs");
        const body = await response.json() as { runs?: RunSummary[] };
        if (cancelled) return;
        const nextRuns = body.runs ?? [];
        setRuns(nextRuns);
        setSelectedRunId((current) => nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id ?? "");
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to list autoresearch runs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const interval = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!selectedRunId) { setArchive(null); return; }
    localStorage.setItem(RUN_STORAGE_KEY, selectedRunId);
    let cancelled = false;
    let interval: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/autoresearch/runs/${encodeURIComponent(selectedRunId)}/archive`, { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to read the selected autoresearch archive");
        const body = await response.json() as Archive;
        if (cancelled) return;
        setArchive(body);
        setError(null);
        if (body.state !== "running" && interval) window.clearInterval(interval);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to read the archive");
      }
    };
    setArchive(null);
    setLoading(true);
    load().finally(() => { if (!cancelled) setLoading(false); });
    interval = window.setInterval(load, 3000);
    return () => { cancelled = true; if (interval) window.clearInterval(interval); };
  }, [selectedRunId]);

  const feasible = useMemo(() => (archive?.iterations ?? []).filter((iteration) => (
    iteration.verdict === "feasible" && iteration.fitness != null && Object.keys(iteration.layout_files ?? {}).length > 0
  )), [archive]);
  const selectedIndex = Math.max(0, feasible.findIndex((iteration) => iteration.id === selectedIterationId));
  const selected = feasible[selectedIndex] ?? null;

  useEffect(() => {
    if (!feasible.length) { setSelectedIterationId(""); return; }
    if (feasible.some((iteration) => iteration.id === selectedIterationId)) return;
    const preferred = archive?.summary?.best_id;
    const next = feasible.find((iteration) => iteration.id === preferred)?.id ?? feasible[feasible.length - 1].id;
    setSelectedIterationId(next);
  }, [archive?.summary?.best_id, feasible, selectedIterationId]);

  useEffect(() => {
    if (!selected || !archive || !selectedRunId) return;
    localStorage.setItem(ITERATION_STORAGE_KEY, selected.id);
    const layoutFile = selected.layout_files?.[activeAoi];
    if (!layoutFile) {
      onUnavailable(selected, selectedRunId);
      setError(`This iteration was not scored on ${activeAoi.replaceAll("_", " ")}. Choose one of its available study areas below.`);
      return;
    }
    const deliveryKey = `${selectedRunId}:${selected.id}:${activeAoi}:${layoutFile}`;
    if (deliveredLayoutKey.current === deliveryKey) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/autoresearch/runs/${encodeURIComponent(selectedRunId)}/files/${layoutFile.split("/").map(encodeURIComponent).join("/")}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`No archived layout is available for ${activeAoi.replaceAll("_", " ")}`);
        return response.json() as Promise<ArchivedLayout>;
      })
      .then((layout) => { if (!cancelled) { deliveredLayoutKey.current = deliveryKey; onLayout(layout, selected, archive, selectedRunId); setError(null); } })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Unable to load the archived layout"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeAoi, archive, onLayout, onUnavailable, selected, selectedRunId]);

  const availableAois = selected ? Object.keys(selected.layout_files ?? {}) : archive?.run?.aois ?? [];
  const selectIteration = (id: string) => setSelectedIterationId(id);
  const objective = selected?.objectives ?? {};

  return (
    <section className={`autoresearch-navigator ${expanded ? "expanded" : "compact"}`} aria-label="Autoresearch progress viewer">
      <div className="autoresearch-toolbar">
        <span className="autoresearch-mode-mark"><GitBranch size={16} /> Autoresearch mode</span>
        <label>
          <span>Run</span>
          <select value={selectedRunId} onChange={(event) => { deliveredLayoutKey.current = ""; setSelectedIterationId(""); setSelectedRunId(event.target.value); }} disabled={!runs.length}>
            {!runs.length && <option value="">No archives found</option>}
            {runs.map((run) => <option key={run.id} value={run.id}>{run.id} · {run.state}</option>)}
          </select>
        </label>
        <div className="autoresearch-iteration-nav">
          <button aria-label="Previous feasible iteration" disabled={selectedIndex <= 0} onClick={() => selectIteration(feasible[selectedIndex - 1]?.id)}><ChevronLeft size={17} /></button>
          <label>
            <span>Iteration</span>
            <select value={selected?.id ?? ""} onChange={(event) => selectIteration(event.target.value)} disabled={!feasible.length}>
              {feasible.map((iteration, index) => <option key={iteration.id} value={iteration.id}>{index + 1} · generation {iteration.generation} · {iteration.policy_name ?? iteration.id}</option>)}
            </select>
          </label>
          <button aria-label="Next feasible iteration" disabled={selectedIndex >= feasible.length - 1} onClick={() => selectIteration(feasible[selectedIndex + 1]?.id)}><ChevronRight size={17} /></button>
        </div>
        <span className={`autoresearch-run-state ${archive?.state === "running" ? "running" : ""}`}>
          {archive?.state === "running" ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
          {archive?.state === "running" ? "Live · polling" : archive ? "Archive complete" : "Waiting"}
        </span>
        <button className="autoresearch-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide details" : "Show details"}</button>
        <button className="autoresearch-close" aria-label="Turn off autoresearch mode" onClick={onClose}><X size={17} /></button>
      </div>

      {expanded && <div className="autoresearch-details">
        {loading && !selected && <div className="autoresearch-empty"><LoaderCircle size={18} /> Reading archive…</div>}
        {error && <div className="autoresearch-error">{error}</div>}
        {!loading && !error && !runs.length && <div className="autoresearch-empty"><Activity size={18} /> No autoresearch archives are available under <code>runs/</code>.</div>}
        {archive && !feasible.length && <div className="autoresearch-empty">This run has not produced a feasible candidate yet. Infeasible candidates are intentionally hidden.</div>}
        {selected && <>
          <div className="autoresearch-policy">
            <span>Feasible policy {selectedIndex + 1} of {feasible.length} · generation {selected.generation}{archive && archive.iterations.length > feasible.length ? ` · ${archive.iterations.length - feasible.length} infeasible hidden` : ""}</span>
            <strong>{selected.policy_name ?? selected.id}</strong>
            <p>{selected.description || "No policy description was recorded for this iteration."}</p>
            <small>Parent {selected.parent_id ?? "none"}{selected.inspiration_ids?.length ? ` · inspired by ${selected.inspiration_ids.join(", ")}` : ""}</small>
          </div>
          <div className="autoresearch-progress">
            <ProgressChart iterations={feasible} selectedId={selected.id} onSelect={selectIteration} />
            <div className="autoresearch-objectives">
              {OBJECTIVES.map((item) => {
                const value = objective[item.key];
                return <div key={item.key}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{value == null ? "—" : item.format(value)}</strong><Sparkline color={item.color} values={feasible.map((iteration) => iteration.objectives?.[item.key])} /></div>;
              })}
              <div><i className="cost" /><span>Spend</span><strong>{formatCost(objective.spend_usd)}</strong><Sparkline color="#af873b" values={feasible.map((iteration) => iteration.objectives?.spend_usd)} /></div>
            </div>
          </div>
          <div className="autoresearch-actions">
            <div className="autoresearch-aoi-tabs" aria-label="Archived study areas">
              {availableAois.map((aoi) => <button key={aoi} className={aoi === activeAoi ? "active" : ""} onClick={() => onSelectAoi(aoi)}>{aoi.replaceAll("_", " ")}</button>)}
            </div>
            <button className="autoresearch-copy" onClick={onCopy}><Copy size={15} /> Copy to editable Design</button>
          </div>
        </>}
      </div>}
    </section>
  );
}

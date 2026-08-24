import { useEffect, useMemo, useState } from "react";
import { ArrowRight, MapPin, Search, X } from "lucide-react";

type OverviewNeighborhood = { name: string; paths: [number, number][][] };
export type OverviewArea = {
  id: string;
  label: string;
  split: "train" | "held_out";
  resolution_m: number;
  ready: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  heat_min_c: number | null;
  heat_max_c: number | null;
};
type OverviewData = {
  resolution_m: number;
  viewbox: [number, number, number, number];
  neighborhoods: OverviewNeighborhood[];
  areas: OverviewArea[];
};

type Props = {
  open: boolean;
  selectedArea: string;
  onClose: () => void;
  onSelect: (area: OverviewArea) => void;
};

const pathData = (path: [number, number][]) => path.map(([x, y], index) => `${index ? "L" : "M"}${x},${y}`).join(" ") + " Z";

export default function StudyAreaOverview({ open, selectedArea, onClose, onSelect }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/study_areas.json")
      .then((response) => {
        if (!response.ok) throw new Error("Boston study-area overview is unavailable");
        return response.json();
      })
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const areas = useMemo(() => (data?.areas ?? [])
    .filter((area) => area.label.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => left.label.localeCompare(right.label)), [data, query]);
  const active = (id: string) => id === selectedArea || id === hovered;

  if (!open) return null;
  return (
    <div className="overview-backdrop" role="presentation">
      <section className="overview-dialog" role="dialog" aria-modal="true" aria-labelledby="overview-title">
        <header className="overview-header">
          <div><span className="eyebrow">Twenty Boston study areas</span><h1 id="overview-title">Choose where to design</h1><p>Each one-kilometre window has its own interventions, cached simulations, and policy scores.</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close Boston overview"><X size={19} /></button>
        </header>
        <div className="overview-body">
          <div className="boston-overview-map">
            {data ? <svg viewBox={data.viewbox.join(" ")} role="img" aria-label="Boston neighborhoods and selectable SHADE study areas">
              <defs>
                <linearGradient id="boston-water" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#eaf3f4" /><stop offset="1" stopColor="#d7e8ea" /></linearGradient>
                <filter id="area-glow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              </defs>
              <rect width="100%" height="100%" fill="url(#boston-water)" />
              <g className="overview-neighborhoods">{data.neighborhoods.flatMap((neighborhood) => neighborhood.paths.map((path, index) => <path key={`${neighborhood.name}-${index}`} d={pathData(path)} />))}</g>
              <g className="overview-area-windows">{data.areas.map((area) => <g key={area.id} className={`${area.split} ${active(area.id) ? "active" : ""} ${area.id === selectedArea ? "selected" : ""}`} onMouseEnter={() => setHovered(area.id)} onMouseLeave={() => setHovered(null)} onClick={() => area.ready && onSelect(area)} role="button" aria-label={`Open ${area.label}`}>
                <rect x={area.x} y={area.y} width={area.width} height={area.height} rx="4" />
                <circle cx={area.x + area.width / 2} cy={area.y + area.height / 2} r={active(area.id) ? 8 : 5} />
              </g>)}</g>
            </svg> : <div className="overview-loading">Preparing Boston overview…</div>}
            <div className="overview-map-caption"><span><i className="train" /> Research areas</span><span><i className="held" /> Evaluation areas</span><strong>{data?.resolution_m ?? 1} m grid</strong></div>
          </div>
          <aside className="overview-area-panel">
            <label className="overview-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a study area" /></label>
            <div className="overview-area-list">
              {areas.map((area) => <button key={area.id} className={`${area.id === selectedArea ? "selected" : ""}`} disabled={!area.ready} onMouseEnter={() => setHovered(area.id)} onMouseLeave={() => setHovered(null)} onClick={() => onSelect(area)}>
                <span className="overview-area-icon"><MapPin size={16} /></span>
                <span><strong>{area.label}</strong><small>{area.split === "held_out" ? "Evaluation area" : "Research area"} · {area.resolution_m.toLocaleString()} m</small></span>
                {area.ready ? <ArrowRight size={15} /> : <em>Preparing</em>}
              </button>)}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

# SOLWEIG 1 m policy replay

These 101 score files are the deterministic 1 m replay of the fixed policies
in `results/evolution/policies/`. They were evaluated for Chinatown, Brighton,
and Grove Hall under the baseline July 27 weather at 10:00, 13:00, and 16:00.

The browser-ready maps, aligned layouts, and resumable SOLWEIG surface caches
are intentionally excluded from Git because they total several gigabytes and
are generated artifacts. To rebuild them after downloading the repository data:

```bash
.venv/bin/python gui/scripts/import_git_results.py
.venv/bin/python gui/scripts/precompute_autoresearch_1m.py --workers 4 --rayon-threads 4
```

Each file under `scores_1m/` records the physics version, spatial resolution,
scenario, hours, aggregate objectives, per-AOI metrics, and intervention spend.
The highest replayed UTCI-relief fitness is `0.025 °C`, from candidate
`gen60_980daac3` (`dense-synergy-corridors no-equity-boost v1`).

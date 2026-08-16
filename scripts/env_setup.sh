#!/usr/bin/env bash
# Creates (or updates) the `shade` conda env from environment.yml.
# Works on Linux, macOS, and Windows via Git Bash. No paths are hardcoded:
# conda is discovered from PATH, then $CONDA_EXE, then the usual install
# locations. Override with $SHADE_CONDA (conda/mamba binary) or
# $SHADE_ENV_NAME (env name, default `shade`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/environment.yml"
ENV_NAME="${SHADE_ENV_NAME:-shade}"

find_conda () {
  if [ -n "${SHADE_CONDA:-}" ]; then echo "$SHADE_CONDA"; return; fi
  # conda, not mamba: mamba 1.x cannot run the `env list`/`env update`
  # subcommands this script relies on. For speed, use conda's libmamba solver
  # (`conda config --set solver libmamba`) rather than the mamba binary.
  if command -v conda >/dev/null 2>&1; then command -v conda; return; fi
  if [ -n "${CONDA_EXE:-}" ] && [ -x "$CONDA_EXE" ]; then echo "$CONDA_EXE"; return; fi
  local base
  for base in "$HOME/miniforge3" "$HOME/mambaforge" "$HOME/miniconda3" "$HOME/anaconda3" \
              "/opt/conda" "/opt/homebrew/Caskroom/miniforge/base" \
              "${USERPROFILE:-/nonexistent}/miniconda3" "${USERPROFILE:-/nonexistent}/anaconda3" \
              "${PROGRAMDATA:-/nonexistent}/miniconda3" "${PROGRAMDATA:-/nonexistent}/anaconda3"; do
    [ -x "$base/bin/conda" ]           && { echo "$base/bin/conda"; return; }
    [ -x "$base/Scripts/conda.exe" ]   && { echo "$base/Scripts/conda.exe"; return; }
  done
  return 1
}

CONDA="$(find_conda)" || {
  echo "error: could not find conda or mamba." >&2
  echo "Install Miniforge (https://conda-forge.org/download/), or point SHADE_CONDA at your conda binary:" >&2
  echo "  SHADE_CONDA=/path/to/conda bash scripts/env_setup.sh" >&2
  exit 1
}
echo "using conda: $CONDA"

if "$CONDA" env list | awk '{print $1}' | grep -qx "$ENV_NAME"; then
  echo "updating existing env '$ENV_NAME' from environment.yml"
  "$CONDA" env update -n "$ENV_NAME" -f "$ENV_FILE"
else
  echo "creating env '$ENV_NAME' from environment.yml"
  "$CONDA" env create -n "$ENV_NAME" -f "$ENV_FILE"
fi

echo "verifying..."
"$CONDA" run -n "$ENV_NAME" python -c "
import geopandas, rasterio, solweig
print('solweig ', getattr(solweig, '__version__', 'ok'))
print('rasterio', rasterio.__version__)
print('geopandas', geopandas.__version__)
"

echo
echo "done. activate with:  conda activate $ENV_NAME"

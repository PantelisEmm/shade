# SHADE GUI

This directory contains the complete browser application:

- `src/` — React interface and map behavior
- `public/` — static artwork and generated browser map layers
- `scripts/` — GUI-specific layer export and SOLWEIG runner
- `vite.config.ts` — development server and local SOLWEIG API

Shared scientific inputs, simulation caches, and the Python virtual environment
remain one level above this directory in `data/`, `runs/`, and `.venv/`.

From this directory, start the app with:

```bash
npm install
npm run dev
```

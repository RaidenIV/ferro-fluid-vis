# Ferrofluid Audio Visualizer

Audio-reactive WebGL ferrofluid visualizer with file/microphone analysis, simulation controls, camera controls, and video/image export.

## Architecture

This repository is intentionally a static browser project. It does **not** require Vite, npm, a build step, a `dist` directory, or a GitHub Actions workflow.

- `index.html` — page markup and browser import map
- `style.css` — visualizer/sidebar styling
- `js/app.js` — UI, playback, controls, and export
- `js/audio-control.js` — audio loading, microphone input, FFT analysis, and playback
- `js/sketch-04.js` — ferrofluid WebGL simulation/rendering
- `js/shader/` — GLSL shaders embedded as browser JavaScript modules
- `assets/` — environment maps and project assets

The runtime libraries (`gl-matrix`, `rxjs`, and `twgl.js`) are loaded as ES modules from jsDelivr, matching the no-build approach used by the Metallic Visualizer project.

## GitHub Pages

Use GitHub Pages **Deploy from a branch**:

1. Repository → **Settings → Pages**.
2. **Build and deployment → Source** → `Deploy from a branch`.
3. **Branch** → `main`.
4. **Folder** → `/(root)`.
5. Click **Save**.

The site is served directly from the repository root. No Actions workflow is needed.

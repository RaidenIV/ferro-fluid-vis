/** hud.js — technical HUD shared by preview, PNG, and video export. */
const HUD_FONT = "Rajdhani, sans-serif";
const HUD_REFERENCE_HEIGHT = 1080;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function titleCase(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function drawCornerTicks(context, width, height, inset, tick) {
  const right = width - inset;
  const bottom = height - inset;
  context.beginPath();
  context.moveTo(inset, inset + tick); context.lineTo(inset, inset); context.lineTo(inset + tick, inset);
  context.moveTo(right - tick, inset); context.lineTo(right, inset); context.lineTo(right, inset + tick);
  context.moveTo(inset, bottom - tick); context.lineTo(inset, bottom); context.lineTo(inset + tick, bottom);
  context.moveTo(right - tick, bottom); context.lineTo(right, bottom); context.lineTo(right, bottom - tick);
  context.stroke();
}

function drawSpectralPanel(context, levels, x, bottom, width, scale) {
  const bands = [
    ["BASS", levels.bass || 0],
    ["MIDS", levels.mids || 0],
    ["TREBLE", levels.treble || 0],
    ["OVERALL", levels.overall || 0],
  ];
  const rowHeight = 13 * scale;
  const headerHeight = 17 * scale;
  const labelWidth = 55 * scale;
  const valueWidth = 29 * scale;
  const gap = 7 * scale;
  const meterWidth = Math.max(42 * scale, width - labelWidth - valueWidth - gap);
  const top = bottom - headerHeight - bands.length * rowHeight;

  context.save();
  context.textBaseline = "top";
  context.textAlign = "left";
  context.font = `600 ${Math.max(8, 8.5 * scale)}px ${HUD_FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  context.fillText("SPECTRAL BANDS", x, top);
  context.fillStyle = "rgba(255,255,255,0.28)";
  context.fillRect(x, top + 12 * scale, width, Math.max(1, scale));

  context.font = `${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
  context.textBaseline = "middle";
  bands.forEach(([name, rawValue], index) => {
    const value = clamp(Number(rawValue) || 0, 0, 1);
    const rowY = top + headerHeight + index * rowHeight;
    const centerY = rowY + rowHeight * 0.5;
    const barX = x + labelWidth;
    const barY = centerY - Math.max(1, 1.75 * scale);
    const barHeight = Math.max(2, 3.5 * scale);

    context.textAlign = "left";
    context.fillStyle = "rgba(255,255,255,0.58)";
    context.fillText(name, x, centerY);

    context.fillStyle = "rgba(255,255,255,0.11)";
    context.fillRect(barX, barY, meterWidth, barHeight);
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillRect(barX, barY, meterWidth * value, barHeight);

    context.textAlign = "right";
    context.fillStyle = "rgba(255,255,255,0.48)";
    context.fillText(`${Math.round(value * 100)}%`, x + width, centerY);
  });
  context.restore();
}

function drawBottomRightStatus(context, width, height, contentInset, scale, opacity, data) {
  const blockWidth = Math.min(width * 0.30, 230 * scale);
  const right = width - contentInset;
  const left = right - blockWidth;
  const bottom = height - contentInset;
  const headerHeight = 17 * scale;
  const rowHeight = 17 * scale;
  const footerHeight = 24 * scale;
  const top = bottom - headerHeight - rowHeight * 3 - footerHeight;
  const barHeight = Math.max(2, 3.5 * scale);

  const reactiveLevel = clamp(Number(data.reactiveLevel) || 0, 0, 1);
  const energy = clamp(Number(data.levels.overall) || 0, 0, 1);
  const agitation = clamp((Number(data.sketch.audioReactive?.agitation) || 0) / 2, 0, 1);
  const rows = [
    ["MASTER ENERGY", energy, `${Math.round(energy * 100)}%`],
    ["REACTION DRIVE", reactiveLevel, `${Math.round(reactiveLevel * 100)}%`],
    ["AGITATION", agitation, `${Number(data.sketch.audioReactive?.agitation || 0).toFixed(2)}×`],
  ];

  context.save();
  context.globalAlpha = opacity;
  context.textBaseline = "top";
  context.textAlign = "right";
  context.font = `600 ${Math.max(8, 8.5 * scale)}px ${HUD_FONT}`;
  context.fillStyle = "rgba(255,255,255,0.78)";
  context.fillText("SYSTEM OUTPUT", right, top);
  context.fillStyle = "rgba(255,255,255,0.28)";
  context.fillRect(left, top + 12 * scale, blockWidth, Math.max(1, scale));

  rows.forEach(([label, value, display], index) => {
    const rowTop = top + headerHeight + index * rowHeight;
    context.font = `${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = "rgba(255,255,255,0.58)";
    context.fillText(label, left, rowTop);
    context.textAlign = "right";
    context.fillStyle = "rgba(255,255,255,0.52)";
    context.fillText(display, right, rowTop);

    const barY = rowTop + 10 * scale;
    context.fillStyle = "rgba(255,255,255,0.11)";
    context.fillRect(left, barY, blockWidth, barHeight);
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillRect(left, barY, blockWidth * value, barHeight);
  });

  const footerTop = top + headerHeight + rowHeight * 3 + 2 * scale;
  const sim = data.sketch.simulationParams || {};
  context.font = `600 ${Math.max(7.5, 8 * scale)}px ${HUD_FONT}`;
  context.textAlign = "right";
  context.fillStyle = "rgba(255,255,255,0.48)";
  context.fillText(
    `FFT ${Number(data.audioControl.FFT_BUFFER_SIZE || 0).toLocaleString()}  /  SPIKES ${Number(data.sketch.audioReactive?.spikeHeight || 0).toFixed(2)}×`,
    right,
    footerTop
  );
  context.fillText(
    `GAS ${Number(sim.GAS_CONST || 0).toFixed(0)}  /  VISC ${Number(sim.VISC || 0).toFixed(1)}`,
    right,
    footerTop + 10 * scale
  );
  context.restore();
}

export function createHudController({
  hudCanvas,
  sourceCanvas,
  sketch,
  audioControl,
  getViewportLabel,
  formatTime,
  getPreviewFps,
  getPerformanceStats,
  isExporting,
}) {
  const state = {
    enabled: true,
    opacity: 0.9,
    scale: 1,
  };

  function collectData() {
    const levels = sketch.audioLevels || { overall: 0, bass: 0, mids: 0, treble: 0 };
    const band = sketch.audioReactive?.band || "overall";
    return {
      sketch,
      audioControl,
      levels,
      reactiveLevel: levels[band] ?? levels.overall ?? 0,
      viewportLabel: getViewportLabel(),
      fps: Math.max(0, Math.round(Number(getPreviewFps?.()) || 0)),
      performance: getPerformanceStats?.() || null,
      exporting: Boolean(isExporting?.()),
    };
  }

  function draw(context, width, height) {
    if (!state.enabled || !context || width <= 0 || height <= 0) return;

    const data = collectData();
    const userScale = clamp(Number(state.scale) || 1, 0.5, 2);
    const scale = userScale * (Math.min(width, height) / HUD_REFERENCE_HEIGHT);
    const opacity = clamp(Number(state.opacity) || 0, 0, 1);
    const frameInset = Math.max(16, 22 * scale);
    const tick = 18 * scale;
    const contentInset = frameInset + tick + Math.max(6, 6 * scale);
    const fontSize = Math.max(9, 12.96 * scale);
    const lineHeight = fontSize * 1.32;
    const camera = sketch.cameraControls || {};
    const sim = sketch.simulationParams || {};

    context.save();
    context.globalAlpha *= opacity;
    context.strokeStyle = "rgba(255,255,255,0.46)";
    context.lineWidth = Math.max(1, scale);
    drawCornerTicks(context, width, height, frameInset, tick);

    context.font = `600 ${fontSize}px ${HUD_FONT}`;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = "rgba(255,255,255,0.84)";

    const current = audioControl.isFileLoaded ? audioControl.currentTime : 0;
    const duration = audioControl.duration || 0;
    const leftLines = [
      "FERROFLUID VISUALIZER / SYSTEM HUD",
      audioControl.fileName || "NO AUDIO LOADED",
      `${data.exporting ? "EXPORT" : audioControl.isPlaying ? "PLAY" : "PAUSE"}  ${formatTime(current)} / ${formatTime(duration)}`,
      `REACTION ${titleCase(sketch.audioReactive?.band || "overall")}  /  VIEWPORT ${String(data.viewportLabel).toUpperCase()}`,
      `MASS ${Number(sim.MASS || 0).toFixed(2)}  /  DENS ${Number(sim.REST_DENS || 0).toFixed(2)}  /  STEPS ${Math.round(Number(sim.STEPS) || 0)}`,
    ];

    leftLines.forEach((line, index) => {
      context.globalAlpha = opacity * (index === 0 ? 1 : 0.76);
      context.fillText(line, contentInset, contentInset + index * lineHeight);
    });

    context.globalAlpha = opacity;
    context.textAlign = "right";
    const rightLines = [
      `${data.fps} FPS`,
      `AZ ${Math.round(Number(camera.yaw) || 0)}° / EL ${Math.round(Number(camera.elevation) || 0)}°`,
      `DIST ${Number(camera.distance || 0).toFixed(2)}`,
      `PARTICLES ${Number(sketch.NUM_PARTICLES || 0).toLocaleString()}`,
    ];
    if (data.performance?.showStats) {
      rightLines.push(
        `FRAME ${Number(data.performance.frameMs || 0).toFixed(1)} MS`,
        `SIM ${Number(data.performance.simulationMs || 0).toFixed(2)} / RENDER ${Number(data.performance.renderMs || 0).toFixed(2)} MS`,
        `QUALITY ${String(data.performance.effectiveQuality || 'ultra').toUpperCase()} / ${Math.round(Number(data.performance.effectiveRenderScale || 1) * 100)}%`
      );
    }
    rightLines.forEach((line, index) => {
      context.fillStyle = index === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.66)";
      context.fillText(line, width - contentInset, contentInset + index * lineHeight);
    });

    const bottomPanelWidth = Math.min(width * 0.30, 230 * scale);
    drawSpectralPanel(context, data.levels, contentInset, height - contentInset, bottomPanelWidth, scale);
    drawBottomRightStatus(context, width, height, contentInset, scale, opacity, data);
    context.restore();
  }

  function renderPreview() {
    if (!hudCanvas) return;
    if (!state.enabled) {
      hudCanvas.hidden = true;
      return;
    }
    hudCanvas.hidden = false;

    const rect = sourceCanvas.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (hudCanvas.width !== width || hudCanvas.height !== height) {
      hudCanvas.width = width;
      hudCanvas.height = height;
    }

    const context = hudCanvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    draw(context, width, height);
  }

  return {
    draw,
    renderPreview,
    setEnabled(value) { state.enabled = Boolean(value); renderPreview(); },
    setOpacity(value) { state.opacity = clamp(Number(value), 0, 1); renderPreview(); },
    setScale(value) { state.scale = clamp(Number(value), 0.5, 2); renderPreview(); },
    getState() { return { hudEnabled: state.enabled, hudOpacity: state.opacity, hudScale: state.scale }; },
  };
}

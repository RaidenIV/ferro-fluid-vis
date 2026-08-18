import { Sketch } from './sketch-04.js';
import { AudioControl } from './audio-control.js';
import { createLoopController } from './loop.js';
import { createHudController } from './hud.js';

const isDev = false;
const audioControl = new AudioControl(isDev);
const canvas = document.querySelector('#visualizer-canvas');
const canvasFrame = document.querySelector('#canvas-frame');
const controls = document.querySelector('#controls');
let sketch = null;
let toastTimer = null;
let activeRecorder = null;
let cancelRequested = false;
let exportCompositeCanvas = null;
let exportCompositeContext = null;
let exportCompositeRaf = 0;

const $ = (selector) => document.querySelector(selector);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

function setStatus(message, state = 'ready') {
    const status = $('#app-status');
    if (!status) return;
    status.querySelector('span:last-child').textContent = message;
    const dot = status.querySelector('.status-dot');
    dot.style.background = state === 'error' ? '#ff4d4d' : state === 'busy' ? '#ffb020' : '#40d87a';
}

function toast(message) {
    const elm = $('#toast');
    elm.textContent = message;
    elm.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elm.classList.remove('show'), 1800);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(value, fallback = 'ferrofluid-visualizer') {
    const clean = String(value || '')
        .replace(/\.[a-z0-9]{1,5}$/i, '')
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    return clean || fallback;
}

/* -------------------------------------------------------------------------
   Visualizer and viewport
------------------------------------------------------------------------- */
sketch = new Sketch(
    canvas,
    audioControl,
    (instance) => instance.run(performance.now()),
    () => setStatus('Visualizer ready'),
    isDev,
    null
);

const loopController = createLoopController(audioControl);
const viewportPresets = {
    fill: null,
    landscape: 16 / 9,
    square: 1,
    portrait: 9 / 16,
};

const viewportLabels = {
    fill: 'Fill Window',
    landscape: 'Landscape — 16:9',
    square: 'Square — 1:1',
    portrait: 'Portrait — 9:16',
};

const hudController = createHudController({
    hudCanvas: $('#hud-canvas'),
    sourceCanvas: canvas,
    sketch,
    audioControl,
    getViewportLabel: () => viewportLabels[$('#viewport-preset')?.value || 'fill'] || 'Fill Window',
    formatTime,
    getPreviewFps: () => sketch.getPerformanceStats().fps,
    getPerformanceStats: () => sketch.getPerformanceStats(),
    isExporting: () => Boolean(activeRecorder),
});

function fitViewport() {
    const preset = $('#viewport-preset')?.value || 'fill';
    const aspect = viewportPresets[preset];
    const availableWidth = window.innerWidth || 1;
    const availableHeight = window.innerHeight || 1;
    let width = availableWidth;
    let height = availableHeight;

    if (aspect) {
        if (availableWidth / availableHeight > aspect) {
            height = availableHeight;
            width = height * aspect;
        } else {
            width = availableWidth;
            height = width / aspect;
        }
        canvasFrame.classList.add('is-framed');
    } else {
        canvasFrame.classList.remove('is-framed');
    }

    canvasFrame.style.width = `${Math.max(1, Math.floor(width))}px`;
    canvasFrame.style.height = `${Math.max(1, Math.floor(height))}px`;
    if (sketch) sketch.resize();
    hudController?.renderPreview();
}

const resizeObserver = new ResizeObserver(() => sketch?.resize());
resizeObserver.observe(canvasFrame);
window.addEventListener('resize', fitViewport);
$('#viewport-preset').addEventListener('change', fitViewport);
fitViewport();

/* -------------------------------------------------------------------------
   Sidebar behavior — mirrors the boid visualizer control panel
------------------------------------------------------------------------- */
function setSectionCollapsed(section, collapsed) {
    section.classList.toggle('is-collapsed', collapsed);
    const toggle = section.querySelector(':scope > .collapsible-header .collapse-toggle');
    if (toggle) {
        toggle.textContent = collapsed ? '+' : '−';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${section.querySelector('h2')?.textContent || 'section'}`;
    }
}

document.querySelectorAll('.section').forEach((section) => {
    const header = section.querySelector(':scope > .collapsible-header h2');
    const toggle = section.querySelector(':scope > .collapsible-header .collapse-toggle');
    const toggleSection = () => setSectionCollapsed(section, !section.classList.contains('is-collapsed'));
    header?.addEventListener('click', toggleSection);
    header?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleSection();
        }
    });
    toggle?.addEventListener('click', toggleSection);
});

$('#minimize-btn').addEventListener('click', () => {
    const collapsed = controls.classList.toggle('collapsed');
    $('#minimize-btn').textContent = collapsed ? '+' : '−';
    $('#minimize-btn').title = collapsed ? 'Expand panel' : 'Collapse panel';
});

/* -------------------------------------------------------------------------
   Linked range + numeric editors
------------------------------------------------------------------------- */
function bindRange(id, valueId, handler, options = {}) {
    const range = $(`#${id}`);
    const valueInput = valueId ? $(`#${valueId}`) : null;
    const toDisplay = options.toDisplay || ((v) => v);
    const fromDisplay = options.fromDisplay || ((v) => v);
    const format = options.format || ((v) => String(v));

    const applyRange = () => {
        const value = Number(range.value);
        if (valueInput) valueInput.value = format(toDisplay(value));
        handler(value);
    };

    const applyValueInput = () => {
        if (!valueInput) return;
        let displayValue = Number(valueInput.value);
        if (!Number.isFinite(displayValue)) {
            valueInput.value = format(toDisplay(Number(range.value)));
            return;
        }
        let value = fromDisplay(displayValue);
        value = clamp(value, Number(range.min), Number(range.max));
        range.value = String(value);
        valueInput.value = format(toDisplay(value));
        handler(value);
    };

    range.addEventListener('input', applyRange);
    valueInput?.addEventListener('change', applyValueInput);
    valueInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') valueInput.blur();
    });
    applyRange();
}

function setControl(id, value, eventName = 'input') {
    const element = $(`#${id}`);
    if (!element) return;
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = String(value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

/* -------------------------------------------------------------------------
   Playback and loop editor
------------------------------------------------------------------------- */
$('#audio-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setStatus('Loading audio', 'busy');
    try {
        await audioControl.loadFile(file);
        audioControl.setVolume(Number($('#volume').value) / 100);
        audioControl.setMuted($('#mute-audio').checked);
        loopController.resetForLoadedAudio();
        $('#track-name').textContent = file.name;
        $('#timeline').disabled = false;
        $('#timeline').max = String(audioControl.duration || 1);
        $('#play-btn').disabled = false;
        $('#reset-audio').disabled = false;
        $('#loop-btn').disabled = false;
        updateExportEstimate();
        setStatus('Visualizer ready');
        toast('Audio loaded');
    } catch (error) {
        console.error(error);
        setStatus('Audio load failed', 'error');
        toast('Could not load audio');
    }
});

$('#play-btn').addEventListener('click', async () => {
    try {
        if (audioControl.isPlaying) {
            audioControl.pause();
        } else {
            loopController.enforceLoopRange();
            await audioControl.play();
        }
    } catch (error) {
        console.error(error);
        toast('Playback could not start');
    }
});

$('#loop-btn').addEventListener('click', () => loopController.open());

$('#reset-audio').addEventListener('click', () => {
    audioControl.resetPlayback();
    loopController.enforceLoopRange();
});

$('#timeline').addEventListener('input', (event) => {
    audioControl.setCurrentTime(Number(event.target.value));
});

bindRange('volume', 'volume-value', (v) => audioControl.setVolume(v / 100), { format: (v) => v.toFixed(0) });
$('#mute-audio').addEventListener('change', (event) => audioControl.setMuted(event.target.checked));

/* -------------------------------------------------------------------------
   Audio analysis and visualizer controls
------------------------------------------------------------------------- */
$('#reactive-enabled').addEventListener('change', (e) => sketch.setAudioReactiveSettings({ enabled: e.target.checked }));
$('#reaction-band').addEventListener('change', (e) => sketch.setAudioReactiveSettings({ band: e.target.value }));
$('#fft-size').addEventListener('change', (e) => audioControl.setFFTSize(Number(e.target.value)));
bindRange('sensitivity', 'sensitivity-value', (v) => audioControl.setSensitivity(v), { format: (v) => v.toFixed(2) });
bindRange('smoothing', 'smoothing-value', (v) => audioControl.setSmoothing(v), {
    toDisplay: (v) => v * 100,
    fromDisplay: (v) => v / 100,
    format: (v) => v.toFixed(0),
});
bindRange('threshold', 'threshold-value', (v) => audioControl.setThreshold(v), { format: (v) => v.toFixed(3) });

bindRange('base-zoom', 'base-zoom-value', (v) => sketch.setBaseZoom(v), { format: (v) => v.toFixed(2) });
bindRange('spike-height', 'spike-height-value', (v) => sketch.setAudioReactiveSettings({ spikeHeight: v }), { format: (v) => v.toFixed(2) });
bindRange('spike-sharpness', 'spike-sharpness-value', (v) => sketch.setAudioReactiveSettings({ spikeSharpness: v }), { format: (v) => v.toFixed(2) });
bindRange('agitation', 'agitation-value', (v) => sketch.setAudioReactiveSettings({ agitation: v }), { format: (v) => v.toFixed(2) });
bindRange('camera-pulse', 'camera-pulse-value', (v) => sketch.setAudioReactiveSettings({ cameraZoom: v }), { format: (v) => v.toFixed(2) });

// Simulation controls update the live GPU simulation UBO through Sketch.
bindRange('mass', 'mass-value', (v) => sketch.setSimulationSettings({ MASS: v }), { format: (v) => v.toFixed(2) });
bindRange('density', 'density-value', (v) => sketch.setSimulationSettings({ REST_DENS: v }), { format: (v) => v.toFixed(2) });
bindRange('gas', 'gas-value', (v) => sketch.setSimulationSettings({ GAS_CONST: v }), { format: (v) => v.toFixed(0) });
bindRange('viscosity', 'viscosity-value', (v) => sketch.setSimulationSettings({ VISC: v }), { format: (v) => v.toFixed(1) });
bindRange('steps', 'steps-value', (v) => sketch.setSimulationSettings({ STEPS: v }), { format: (v) => v.toFixed(0) });
bindRange('pointer-radius', 'pointer-radius-value', (v) => sketch.setPointerSettings({ RADIUS: v }), { format: (v) => v.toFixed(2) });
bindRange('pointer-strength', 'pointer-strength-value', (v) => sketch.setPointerSettings({ STRENGTH: v }), { format: (v) => v.toFixed(0) });

bindRange('yaw', 'yaw-value', (v) => sketch.setCameraSettings({ yaw: v }), { format: (v) => v.toFixed(1) });
bindRange('elevation', 'elevation-value', (v) => sketch.setCameraSettings({ elevation: v }), { format: (v) => v.toFixed(1) });
bindRange('distance', 'distance-value', (v) => sketch.setCameraSettings({ distance: v }), { format: (v) => v.toFixed(2) });
$('#auto-rotate').addEventListener('change', (e) => sketch.setCameraSettings({ autoRotate: e.target.checked }));
bindRange('rotate-speed', 'rotate-speed-value', (v) => sketch.setCameraSettings({ rotateSpeed: v }), { format: (v) => v.toFixed(1) });
$('#reset-camera').addEventListener('click', () => {
    sketch.resetCamera();
    syncCameraUI();
    toast('Visualization centered');
});

$('#background-color').addEventListener('input', (e) => sketch.setAppearanceSettings({ backgroundColor: e.target.value }));
bindRange('brightness', 'brightness-value', (v) => sketch.setAppearanceSettings({ materialBrightness: v }), { format: (v) => v.toFixed(2) });
bindRange('iridescence', 'iridescence-value', (v) => sketch.setAppearanceSettings({ iridescence: v }), { format: (v) => v.toFixed(2) });

$('#hud-enabled').addEventListener('change', (e) => hudController.setEnabled(e.target.checked));
bindRange('hud-opacity', 'hud-opacity-value', (v) => hudController.setOpacity(v), { format: (v) => v.toFixed(2) });
bindRange('hud-scale', 'hud-scale-value', (v) => hudController.setScale(v), { format: (v) => v.toFixed(2) });

$('#performance-mode').addEventListener('change', (e) => sketch.setPerformanceSettings({ mode: e.target.value }));
$('#simulation-quality').addEventListener('change', (e) => sketch.setPerformanceSettings({ simulationQuality: e.target.value }));
bindRange('render-scale', 'render-scale-value', (v) => sketch.setPerformanceSettings({ renderScale: v / 100 }), { format: (v) => v.toFixed(0) });
$('#adaptive-simulation').addEventListener('change', (e) => sketch.setPerformanceSettings({ adaptiveSimulation: e.target.checked }));
$('#fps-limit').addEventListener('change', (e) => sketch.setPerformanceSettings({ fpsLimit: Number(e.target.value) }));
$('#show-performance-stats').addEventListener('change', (e) => sketch.setPerformanceSettings({ showStats: e.target.checked }));
sketch.setPerformanceSettings({
    mode: $('#performance-mode').value,
    simulationQuality: $('#simulation-quality').value,
    renderScale: Number($('#render-scale').value) / 100,
    adaptiveSimulation: $('#adaptive-simulation').checked,
    fpsLimit: Number($('#fps-limit').value),
    showStats: $('#show-performance-stats').checked,
});

function syncCameraUI() {
    const c = sketch.cameraControls;
    const pairs = [
        ['yaw', 'yaw-value', c.yaw, c.yaw.toFixed(1)],
        ['elevation', 'elevation-value', c.elevation, c.elevation.toFixed(1)],
        ['distance', 'distance-value', c.distance, c.distance.toFixed(2)],
    ];
    pairs.forEach(([id, valueId, value, label]) => {
        const range = $(`#${id}`);
        const input = $(`#${valueId}`);
        if (document.activeElement !== range) range.value = String(value);
        if (document.activeElement !== input) input.value = label;
    });
    $('#auto-rotate').checked = Boolean(c.autoRotate);
}

/* -------------------------------------------------------------------------
   Section reset controls
------------------------------------------------------------------------- */
const sectionDefaults = {
    playback: () => {
        setControl('volume', 85);
        setControl('mute-audio', false, 'change');
        audioControl.resetPlayback();
        loopController.resetForLoadedAudio();
    },
    viewport: () => setControl('viewport-preset', 'fill', 'change'),
    audio: () => {
        setControl('reactive-enabled', true, 'change');
        setControl('reaction-band', 'overall', 'change');
        setControl('fft-size', 2048, 'change');
        setControl('sensitivity', 1.35);
        setControl('smoothing', 0.72);
        setControl('threshold', 0.025);
    },
    ferrofluid: () => {
        setControl('base-zoom', 0.5);
        setControl('spike-height', 1.35);
        setControl('spike-sharpness', 0.45);
        setControl('agitation', 0.65);
        setControl('camera-pulse', 0);
    },
    simulation: () => {
        setControl('mass', 1);
        setControl('density', 1.8);
        setControl('gas', 40);
        setControl('viscosity', 5.5);
        setControl('steps', 0);
        setControl('pointer-radius', 1.1);
        setControl('pointer-strength', 15);
    },
    camera: () => {
        sketch.resetCamera();
        setControl('rotate-speed', 6);
        syncCameraUI();
    },
    appearance: () => {
        setControl('background-color', '#050505');
        setControl('brightness', 1);
        setControl('iridescence', 1);
    },
    hud: () => {
        setControl('hud-enabled', true, 'change');
        setControl('hud-opacity', 0.9);
        setControl('hud-scale', 1);
    },
    performance: () => {
        // Reset through Manual first so any Auto-mode downshift state is cleared,
        // then return to the default Auto mode at full quality.
        setControl('performance-mode', 'manual', 'change');
        setControl('simulation-quality', 'ultra', 'change');
        setControl('render-scale', 100);
        setControl('adaptive-simulation', true, 'change');
        setControl('fps-limit', 60, 'change');
        setControl('show-performance-stats', false, 'change');
        setControl('performance-mode', 'auto', 'change');
    },
    export: () => {
        $('#export-file-name').value = '';
        resetExportFormatControls();
        updateExportEstimate();
        setSettingsStatus('Settings import validates compatible JSON presets.', 'idle');
    },
    'export-format': () => {
        resetExportFormatControls();
        updateExportEstimate();
    },
};

document.querySelectorAll('[data-reset-section]').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const section = button.dataset.resetSection;
        sectionDefaults[section]?.();
        toast(`${button.closest('.section')?.querySelector('h2')?.textContent || 'Section'} reset`);
    });
});

/* -------------------------------------------------------------------------
   Export — options mirror boid-vis-main(1).zip
------------------------------------------------------------------------- */
const isFirefoxBrowser = /Firefox\//i.test(navigator.userAgent);
const exportDefaults = {
    fileType: isFirefoxBrowser ? 'mkv' : 'mp4',
    resolution: '4k',
    frameRate: 60,
    bitrateMbps: 24,
};

function resetExportFormatControls() {
    setControl('export-resolution', exportDefaults.resolution, 'change');
    setControl('video-file-type', exportDefaults.fileType, 'change');
    setControl('video-frame-rate', exportDefaults.frameRate, 'change');
    setControl('video-bitrate', exportDefaults.bitrateMbps, 'change');
}

function getViewportAspect() {
    const preset = $('#viewport-preset')?.value || 'fill';
    const aspect = viewportPresets[preset];
    if (aspect) return aspect;
    return Math.max(1, window.innerWidth || canvas.clientWidth || 16) /
        Math.max(1, window.innerHeight || canvas.clientHeight || 9);
}

function toEvenInteger(value) {
    const rounded = Math.max(2, Math.round(Number(value) || 2));
    return rounded % 2 === 0 ? rounded : rounded + 1;
}

function getExportResolution() {
    const shortSides = { '1080': 1080, '2k': 1440, '4k': 2160 };
    const shortSide = shortSides[$('#export-resolution').value] || 2160;
    const aspect = getViewportAspect();
    let width;
    let height;
    if (aspect >= 1) {
        height = shortSide;
        width = height * aspect;
    } else {
        width = shortSide;
        height = width / aspect;
    }
    return { width: toEvenInteger(width), height: toEvenInteger(height), changed: true };
}

function getVideoFileType() {
    return $('#video-file-type').value === 'mkv' ? 'mkv' : 'mp4';
}

function getMime(fileType) {
    const candidates = fileType === 'mp4'
        ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']
        : [
            'video/x-matroska;codecs=vp9,opus',
            'video/x-matroska;codecs=vp8,opus',
            'video/x-matroska',
            // Firefox exposes its Matroska/WebM encoder under WebM MIME names.
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ];
    return candidates.find((mime) => window.MediaRecorder?.isTypeSupported?.(mime)) || null;
}

function nextFrames(count = 2) {
    return new Promise((resolve) => {
        const tick = () => count-- <= 0 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
    });
}

function ensureExportCompositeCanvas(width, height) {
    if (!exportCompositeCanvas) {
        exportCompositeCanvas = document.createElement('canvas');
        exportCompositeContext = exportCompositeCanvas.getContext('2d', { alpha: false });
    }
    if (exportCompositeCanvas.width !== width || exportCompositeCanvas.height !== height) {
        exportCompositeCanvas.width = width;
        exportCompositeCanvas.height = height;
    }
    return exportCompositeCanvas;
}

function compositeExportFrame(width, height) {
    const output = ensureExportCompositeCanvas(width, height);
    exportCompositeContext.fillStyle = '#000000';
    exportCompositeContext.fillRect(0, 0, width, height);
    exportCompositeContext.drawImage(canvas, 0, 0, width, height);
    hudController.draw(exportCompositeContext, width, height);
    return output;
}

function startExportCompositeLoop(width, height) {
    stopExportCompositeLoop();
    const draw = () => {
        compositeExportFrame(width, height);
        exportCompositeRaf = requestAnimationFrame(draw);
    };
    draw();
}

function stopExportCompositeLoop() {
    if (exportCompositeRaf) cancelAnimationFrame(exportCompositeRaf);
    exportCompositeRaf = 0;
}

function formatDurationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getExportRange() {
    if (!audioControl.isFileLoaded) return { start: 0, end: 0, duration: 0, active: false };
    return loopController.getExportRange();
}

function getExportFileBaseName() {
    const custom = $('#export-file-name').value.trim();
    return safeFilename(custom || audioControl.fileName || 'ferrofluid-visualizer');
}

function setExportStatus(message, state = 'idle') {
    const status = $('#export-status');
    status.textContent = message;
    status.dataset.state = state;
}

function setSettingsStatus(message, state = 'idle') {
    const status = $('#settings-status');
    status.textContent = message;
    status.dataset.state = state;
}

function updateExportEstimate() {
    const range = getExportRange();
    if (!range.duration) {
        $('#export-estimate-duration').textContent = '—';
        $('#export-estimate-size').textContent = '—';
        $('#export-estimate-time').textContent = '—';
        return;
    }
    const { width, height } = getExportResolution();
    const fps = Number($('#video-frame-rate').value) || 60;
    const bitrate = (Number($('#video-bitrate').value) || 24) * 1_000_000;
    const estimatedBytes = range.duration * (bitrate + 192_000) / 8 * 1.03;
    const pixelScale = (width * height) / (1920 * 1080);
    const fpsScale = fps / 30;
    const estimatedSeconds = range.duration * clamp(0.28 * pixelScale * fpsScale, 0.25, 6);
    $('#export-estimate-duration').textContent = formatDurationLabel(range.duration);
    $('#export-estimate-size').textContent = `≈ ${formatBytes(estimatedBytes)}`;
    $('#export-estimate-time').textContent = `≈ ${formatDurationLabel(estimatedSeconds)}`;
}

function setExportProgress(show, progress = 0, stage = 'Preparing', meta = {}) {
    const pct = clamp(progress, 0, 1);
    const percent = Math.round(pct * 100);
    $('#export-progress-wrap').hidden = !show;
    $('#export-progress').value = percent;
    $('#export-progress-text').textContent = `${percent}%`;
    $('#export-overlay-progress').value = percent;
    $('#export-overlay-progress-text').textContent = `${percent}%`;
    $('#export-overlay-detail').textContent = `${stage} · ${percent}%`;
    $('#export-progress-stage').textContent = stage;
    $('#export-overlay-stage').textContent = stage;

    const elapsed = Number(meta.elapsed) || 0;
    const duration = Number(meta.duration) || 0;
    const frame = Number(meta.frame) || 0;
    const totalFrames = Number(meta.totalFrames) || 0;
    const eta = pct > 0.01 && elapsed > 0 ? Math.max(0, elapsed * (1 - pct) / pct) : 0;
    const timeLabel = duration ? `${formatDurationLabel(Math.min(duration, pct * duration))} / ${formatDurationLabel(duration)}` : '—';
    const frameLabel = totalFrames ? `${Math.min(frame, totalFrames)} / ${totalFrames}` : '—';
    const etaLabel = eta ? formatDurationLabel(eta) : '—';
    $('#export-progress-time').textContent = timeLabel;
    $('#export-overlay-time').textContent = timeLabel;
    $('#export-progress-frames').textContent = frameLabel;
    $('#export-overlay-frames').textContent = frameLabel;
    $('#export-progress-eta').textContent = etaLabel;
    $('#export-overlay-eta').textContent = etaLabel;
}

function setExportUiActive(active) {
    $('#export-overlay').classList.toggle('active', active);
    $('#export-video').textContent = active ? 'Cancel Video Export' : 'Export Video';
    $('#export-video').classList.toggle('is-cancel', active);
    $('#export-png').disabled = active;
    $('#export-json').disabled = active;
    $('#import-json').disabled = active;
    $('#video-file-type').disabled = active;
    $('#video-frame-rate').disabled = active;
    $('#video-bitrate').disabled = active;
    $('#export-resolution').disabled = active;
}

async function exportVideo() {
    if (activeRecorder) {
        cancelRequested = true;
        return;
    }
    if (!audioControl.isFileLoaded) {
        setExportStatus('Load an audio file before video export.', 'error');
        toast('Load an audio file before video export');
        return;
    }
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
        setExportStatus('Video export is not supported in this browser.', 'error');
        toast('Video export is not supported in this browser');
        return;
    }

    const fileType = getVideoFileType();
    const mimeType = getMime(fileType);
    if (!mimeType) {
        setExportStatus(`${fileType.toUpperCase()} export is not supported by this browser.`, 'error');
        toast(`${fileType.toUpperCase()} export is not supported in this browser`);
        return;
    }

    const range = getExportRange();
    if (!range.duration) {
        setExportStatus('Audio duration is unavailable.', 'error');
        toast('Audio duration is unavailable');
        return;
    }

    const previous = {
        time: audioControl.currentTime,
        playing: audioControl.isPlaying,
        nativeLoop: audioControl.audioElement.loop,
        muted: audioControl.monitorMuted,
    };
    const startTime = range.start;
    const endTime = range.end;
    const exportDuration = range.duration;
    const fps = Number($('#video-frame-rate').value) || 60;
    const bitrate = (Number($('#video-bitrate').value) || 24) * 1_000_000;
    const resolution = getExportResolution();
    const totalFrames = Math.max(1, Math.ceil(exportDuration * fps));
    cancelRequested = false;
    const startedAt = performance.now();

    setStatus('Exporting video', 'busy');
    setExportUiActive(true);
    setExportStatus(`Preparing ${fileType.toUpperCase()} encoder · ${fps} FPS · ${(bitrate / 1_000_000).toFixed(0)} Mbps…`, 'active');
    setExportProgress(true, 0.01, 'Preparing', { duration: exportDuration, totalFrames });

    let canvasStream = null;
    try {
        audioControl.pause();
        audioControl.useFileInput();
        audioControl.setLoop(false);
        audioControl.setMuted(true);
        audioControl.setCurrentTime(startTime);

        sketch.setDrawingBufferSize(resolution.width, resolution.height);
        sketch.setExportMode(true);
        await nextFrames(2);

        const exportCanvas = compositeExportFrame(resolution.width, resolution.height);
        startExportCompositeLoop(resolution.width, resolution.height);
        canvasStream = exportCanvas.captureStream(fps);
        const audioStream = audioControl.getCaptureStream();
        const tracks = [...canvasStream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
        const combinedStream = new MediaStream(tracks);
        const chunks = [];
        const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: bitrate });
        activeRecorder = recorder;

        recorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size) chunks.push(event.data);
        });
        const stopped = new Promise((resolve, reject) => {
            recorder.addEventListener('stop', resolve, { once: true });
            recorder.addEventListener('error', (event) => reject(event.error || new Error('Recording failed')), { once: true });
        });

        recorder.start(1000);
        await audioControl.play();
        setExportStatus(`Recording ${fileType.toUpperCase()}…`, 'active');

        await new Promise((resolve) => {
            const check = () => {
                const progress = clamp((audioControl.currentTime - startTime) / exportDuration, 0, 1);
                const elapsed = (performance.now() - startedAt) / 1000;
                setExportProgress(true, Math.max(0.01, progress * 0.97), cancelRequested ? 'Cancelling' : 'Encoding frames', {
                    elapsed,
                    duration: exportDuration,
                    frame: Math.round(progress * totalFrames),
                    totalFrames,
                });
                if (cancelRequested || audioControl.currentTime >= endTime - 0.025 || audioControl.audioElement.ended) {
                    resolve();
                    return;
                }
                requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        });

        audioControl.pause();
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;

        if (!cancelRequested) {
            setExportProgress(true, 0.99, `Finalizing ${fileType.toUpperCase()}`, {
                elapsed: (performance.now() - startedAt) / 1000,
                duration: exportDuration,
                frame: totalFrames,
                totalFrames,
            });
            const blob = new Blob(chunks, { type: mimeType });
            downloadBlob(blob, `${getExportFileBaseName()}.${fileType}`);
            setExportProgress(true, 1, 'Complete', {
                elapsed: (performance.now() - startedAt) / 1000,
                duration: exportDuration,
                frame: totalFrames,
                totalFrames,
            });
            setExportStatus(`${fileType.toUpperCase()} exported · ${resolution.width}×${resolution.height} · ${formatBytes(blob.size)}`, 'done');
            toast('Video export complete');
        } else {
            setExportStatus('Video export cancelled.', 'idle');
            toast('Video export cancelled');
        }
    } catch (error) {
        console.error(error);
        setExportStatus(`VIDEO EXPORT ERROR / ${error.message}`, 'error');
        toast('Video export failed');
        setStatus('Export failed', 'error');
    } finally {
        stopExportCompositeLoop();
        activeRecorder = null;
        canvasStream?.getTracks().forEach((track) => track.stop());
        sketch.setExportMode(false);
        sketch.restoreDisplayResolution();
        await nextFrames(1);
        fitViewport();
        audioControl.audioElement.loop = previous.nativeLoop;
        audioControl.setMuted(previous.muted);
        audioControl.setCurrentTime(previous.time);
        loopController.syncButton();
        if (previous.playing) {
            try { await audioControl.play(); } catch (_) {}
        }
        setExportUiActive(false);
        setExportProgress(false);
        setStatus(cancelRequested ? 'Export cancelled' : 'Visualizer ready');
        updateExportEstimate();
    }
}

$('#export-video').addEventListener('click', exportVideo);
$('#export-cancel').addEventListener('click', () => { cancelRequested = true; });

$('#export-png').addEventListener('click', async () => {
    const resolution = getExportResolution();
    setStatus('Exporting PNG', 'busy');
    try {
        sketch.setDrawingBufferSize(resolution.width, resolution.height);
        sketch.setExportMode(true);
        await nextFrames(2);
        const exportCanvas = compositeExportFrame(resolution.width, resolution.height);
        const blob = await new Promise((resolve, reject) => exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG capture failed')), 'image/png'));
        downloadBlob(blob, `${getExportFileBaseName()}-frame.png`);
        setExportStatus(`PNG exported at ${resolution.width}×${resolution.height}.`, 'done');
        toast('PNG exported');
    } catch (error) {
        console.error(error);
        setExportStatus(`EXPORT ERROR / ${error.message}`, 'error');
        toast('PNG export failed');
    } finally {
        sketch.setExportMode(false);
        sketch.restoreDisplayResolution();
        fitViewport();
        setStatus('Visualizer ready');
    }
});

function buildSettingsPayload() {
    return {
        schemaVersion: 1,
        app: 'ferrofluid-audio-reactive',
        settings: sketch.getSerializableState(),
        audio: {
            fftSize: Number($('#fft-size').value),
            sensitivity: audioControl.sensitivity,
            smoothing: audioControl.smoothing,
            threshold: audioControl.threshold,
            volume: Number($('#volume').value),
            muted: $('#mute-audio').checked,
            loop: loopController.getState(),
        },
        viewport: $('#viewport-preset').value,
        hud: hudController.getState(),
        export: {
            fileType: getVideoFileType(),
            resolution: $('#export-resolution').value,
            frameRate: Number($('#video-frame-rate').value),
            bitrateMbps: Number($('#video-bitrate').value),
            fileName: $('#export-file-name').value,
        },
    };
}

$('#export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildSettingsPayload(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${getExportFileBaseName()}.json`);
    setSettingsStatus('Settings exported as versioned JSON.', 'done');
    toast('Settings JSON exported');
});

function applyImportedSettings(payload) {
    if (!payload || payload.schemaVersion !== 1 || payload.app !== 'ferrofluid-audio-reactive') {
        throw new Error('Incompatible settings file.');
    }
    const settings = payload.settings || {};
    const reactive = settings.audioReactive || {};
    const simulation = settings.simulation || {};
    const pointer = settings.pointer || {};
    const camera = settings.camera || {};
    const appearance = settings.appearance || {};
    const performanceSettings = settings.performance || {};
    const audio = payload.audio || {};
    const exportSettings = payload.export || {};
    const hud = payload.hud || {};

    if (settings.baseZoom != null) setControl('base-zoom', settings.baseZoom);
    if (reactive.enabled != null) setControl('reactive-enabled', reactive.enabled, 'change');
    if (reactive.band) setControl('reaction-band', reactive.band, 'change');
    if (reactive.spikeHeight != null) setControl('spike-height', reactive.spikeHeight);
    if (reactive.spikeSharpness != null) setControl('spike-sharpness', reactive.spikeSharpness);
    if (reactive.agitation != null) setControl('agitation', reactive.agitation);
    if (reactive.cameraZoom != null) setControl('camera-pulse', reactive.cameraZoom);
    if (simulation.MASS != null) setControl('mass', simulation.MASS);
    if (simulation.REST_DENS != null) setControl('density', simulation.REST_DENS);
    if (simulation.GAS_CONST != null) setControl('gas', simulation.GAS_CONST);
    if (simulation.VISC != null) setControl('viscosity', simulation.VISC);
    if (simulation.STEPS != null) setControl('steps', simulation.STEPS);
    if (pointer.RADIUS != null) setControl('pointer-radius', pointer.RADIUS);
    if (pointer.STRENGTH != null) setControl('pointer-strength', pointer.STRENGTH);
    if (camera.yaw != null) setControl('yaw', camera.yaw);
    if (camera.elevation != null) setControl('elevation', camera.elevation);
    if (camera.distance != null) setControl('distance', camera.distance);
    if (camera.autoRotate != null) setControl('auto-rotate', camera.autoRotate, 'change');
    if (camera.rotateSpeed != null) setControl('rotate-speed', camera.rotateSpeed);
    if (appearance.backgroundColor) setControl('background-color', appearance.backgroundColor);
    if (appearance.materialBrightness != null) setControl('brightness', appearance.materialBrightness);
    if (appearance.iridescence != null) setControl('iridescence', appearance.iridescence);
    if (Object.keys(performanceSettings).length) {
        const importedMode = performanceSettings.mode || 'auto';
        setControl('performance-mode', 'manual', 'change');
        if (performanceSettings.simulationQuality) setControl('simulation-quality', performanceSettings.simulationQuality, 'change');
        if (performanceSettings.renderScale != null) setControl('render-scale', performanceSettings.renderScale * 100);
        if (performanceSettings.adaptiveSimulation != null) setControl('adaptive-simulation', performanceSettings.adaptiveSimulation, 'change');
        if (performanceSettings.fpsLimit != null) setControl('fps-limit', performanceSettings.fpsLimit, 'change');
        if (performanceSettings.showStats != null) setControl('show-performance-stats', performanceSettings.showStats, 'change');
        setControl('performance-mode', importedMode, 'change');
    }
    if (audio.fftSize != null) setControl('fft-size', audio.fftSize, 'change');
    if (audio.sensitivity != null) setControl('sensitivity', audio.sensitivity);
    if (audio.smoothing != null) setControl('smoothing', audio.smoothing);
    if (audio.threshold != null) setControl('threshold', audio.threshold);
    if (audio.volume != null) setControl('volume', audio.volume);
    if (audio.muted != null) setControl('mute-audio', audio.muted, 'change');
    if (hud.hudEnabled != null) setControl('hud-enabled', hud.hudEnabled, 'change');
    if (hud.hudOpacity != null) setControl('hud-opacity', hud.hudOpacity);
    if (hud.hudScale != null) setControl('hud-scale', hud.hudScale);
    if (payload.viewport) setControl('viewport-preset', payload.viewport, 'change');
    if (exportSettings.fileType) setControl('video-file-type', exportSettings.fileType, 'change');
    if (exportSettings.resolution) setControl('export-resolution', exportSettings.resolution, 'change');
    if (exportSettings.frameRate != null) setControl('video-frame-rate', exportSettings.frameRate, 'change');
    if (exportSettings.bitrateMbps != null) setControl('video-bitrate', exportSettings.bitrateMbps, 'change');
    if (typeof exportSettings.fileName === 'string') $('#export-file-name').value = exportSettings.fileName;
    syncCameraUI();
    updateExportEstimate();
}

$('#import-json').addEventListener('click', () => $('#import-json-file').click());
$('#import-json-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
        const payload = JSON.parse(await file.text());
        applyImportedSettings(payload);
        setSettingsStatus('Settings imported successfully.', 'done');
        toast('Settings imported');
    } catch (error) {
        console.error(error);
        setSettingsStatus(`IMPORT ERROR / ${error.message}`, 'error');
        toast('Settings import failed');
    }
});

['export-resolution', 'video-file-type', 'video-frame-rate', 'video-bitrate'].forEach((id) => {
    $(`#${id}`).addEventListener('change', () => {
        updateExportEstimate();
        const fileType = getVideoFileType();
        if (isFirefoxBrowser && fileType === 'mp4') {
            setExportStatus('Firefox cannot reliably export MP4. Select MKV for Firefox export.', 'error');
        } else {
            setExportStatus(`${fileType.toUpperCase()} export requires a loaded audio file and browser video encoding support.`, 'idle');
        }
    });
});
window.addEventListener('visualizer-loop-changed', updateExportEstimate);
$('#viewport-preset').addEventListener('change', updateExportEstimate);

resetExportFormatControls();
updateExportEstimate();
setExportStatus(
    isFirefoxBrowser
        ? 'Firefox export defaults to MKV. MP4 is best exported in Chrome or Edge.'
        : 'MP4 export requires a loaded audio file and browser video encoding support.',
    'idle'
);

/* -------------------------------------------------------------------------
   Runtime UI synchronization
------------------------------------------------------------------------- */
let lastUiUpdate = 0;
function updateUI(time) {
    if (audioControl.isFileLoaded && !activeRecorder) loopController.enforceLoopRange();

    if (time - lastUiUpdate > 50) {
        lastUiUpdate = time;
        if (audioControl.isFileLoaded) {
            const timeline = $('#timeline');
            if (document.activeElement !== timeline && !activeRecorder) timeline.value = String(audioControl.currentTime);
            $('#time-readout').textContent = `${formatTime(audioControl.currentTime)} / ${formatTime(audioControl.duration)}`;
            const play = $('#play-btn');
            play.textContent = audioControl.isPlaying ? '⏸ Pause' : '▶ Play';
            play.className = audioControl.isPlaying ? 'pause' : 'play';
        }

        const levels = sketch.audioLevels;
        ['bass', 'mids', 'treble', 'overall'].forEach((key) => {
            $(`#meter-${key}`).style.width = `${clamp(levels[key] || 0, 0, 1) * 100}%`;
        });
        if (sketch.cameraControls.autoRotate || sketch.isOrbiting) syncCameraUI();
        hudController.renderPreview();
    }

    if (!updateUI.lastPerformanceUpdate || time - updateUI.lastPerformanceUpdate > 250) {
        updateUI.lastPerformanceUpdate = time;
        const stats = sketch.getPerformanceStats();
        $('#perf-fps').textContent = `${Math.round(stats.fps)}`;
        $('#perf-frame').textContent = `${stats.frameMs.toFixed(1)} ms`;
        $('#perf-simulation').textContent = `${stats.simulationMs.toFixed(2)} ms`;
        $('#perf-render').textContent = `${stats.renderMs.toFixed(2)} ms`;
        $('#perf-effective').textContent = `${String(stats.effectiveQuality).toUpperCase()} / ${Math.round(stats.effectiveRenderScale * 100)}%`;
        $('#perf-solver').textContent = `${stats.effectiveSteps} step${stats.effectiveSteps === 1 ? '' : 's'} @ ${Math.round(stats.simulationHz)} Hz`;
    }
    requestAnimationFrame(updateUI);
}
requestAnimationFrame(updateUI);

setStatus('Visualizer ready');

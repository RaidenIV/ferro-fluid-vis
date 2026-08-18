import { Sketch } from './sketch-04.js';
import { AudioControl } from './audio-control.js';
import { createLoopController } from './loop.js';

const isDev = false;
const audioControl = new AudioControl(isDev);
const canvas = document.querySelector('#visualizer-canvas');
const canvasFrame = document.querySelector('#canvas-frame');
const controls = document.querySelector('#controls');
let sketch = null;
let toastTimer = null;
let activeRecorder = null;
let cancelRequested = false;

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
    const clean = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
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
        const base = file.name.replace(/\.[^.]+$/, '');
        $('#export-filename').value = `${base}-ferrofluid`;
        setStatus('Audio loaded');
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

$('#microphone').addEventListener('click', async () => {
    try {
        if (audioControl.inputType === 'microphone') {
            audioControl.stopMicrophone();
            if (audioControl.isFileLoaded) audioControl.useFileInput();
            $('#microphone').textContent = 'Microphone';
            setStatus(audioControl.isFileLoaded ? 'Audio file active' : 'Microphone stopped');
            return;
        }
        setStatus('Requesting microphone', 'busy');
        await audioControl.initMicrophone();
        $('#microphone').textContent = 'Stop Mic';
        setStatus('Microphone active');
    } catch (error) {
        console.error(error);
        setStatus('Microphone unavailable', 'error');
        toast('Microphone permission denied');
    }
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
    export: () => {
        $('#export-filename').value = 'ferrofluid-visualizer';
        setControl('export-format', 'webm', 'change');
        setControl('export-fps', 60, 'change');
        setControl('export-resolution', '1920x1080', 'change');
        setControl('export-bitrate', 16000000, 'change');
        setControl('export-range', 'full', 'change');
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
   Export
------------------------------------------------------------------------- */
function getExportResolution() {
    const value = $('#export-resolution').value;
    if (value === 'current') return { width: canvas.width, height: canvas.height, changed: false };
    const [width, height] = value.split('x').map(Number);
    return { width, height, changed: true };
}

function getMime(format) {
    const candidates = format === 'mp4'
        ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']
        : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return candidates.find((mime) => window.MediaRecorder?.isTypeSupported?.(mime)) || null;
}

function nextFrames(count = 2) {
    return new Promise((resolve) => {
        const tick = () => count-- <= 0 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
    });
}

function setExportProgress(show, progress = 0, stage = 'Preparing') {
    $('#export-progress').hidden = !show;
    const pct = clamp(progress, 0, 1);
    $('#export-progress-bar').value = pct * 100;
    $('#export-percent').textContent = `${Math.round(pct * 100)}%`;
    $('#export-stage').textContent = stage;
}

$('#export-video').addEventListener('click', async () => {
    if (!audioControl.isFileLoaded) {
        toast('Load an audio file before video export');
        return;
    }
    if (!window.MediaRecorder || !canvas.captureStream) {
        toast('Video export is not supported in this browser');
        return;
    }

    const format = $('#export-format').value;
    const mimeType = getMime(format);
    if (!mimeType) {
        toast(`${format.toUpperCase()} recording is not supported in this browser`);
        return;
    }

    const duration = audioControl.duration;
    if (!duration) {
        toast('Audio duration is unavailable');
        return;
    }

    const previous = {
        time: audioControl.currentTime,
        playing: audioControl.isPlaying,
        nativeLoop: audioControl.audioElement.loop,
        muted: audioControl.monitorMuted,
    };

    const selectedLoop = loopController.getExportRange();
    const rangeMode = $('#export-range').value;
    let startTime;
    let endTime;
    if (rangeMode === 'full' && selectedLoop.active) {
        startTime = selectedLoop.start;
        endTime = selectedLoop.end;
    } else if (rangeMode === 'current') {
        startTime = Math.min(previous.time, Math.max(0, duration - 0.05));
        endTime = selectedLoop.active && startTime < selectedLoop.end ? selectedLoop.end : duration;
    } else {
        startTime = 0;
        endTime = duration;
    }

    const exportDuration = Math.max(0.05, endTime - startTime);
    const fps = Number($('#export-fps').value);
    const bitrate = Number($('#export-bitrate').value);
    const resolution = getExportResolution();
    cancelRequested = false;

    setStatus('Exporting video', 'busy');
    setExportProgress(true, 0, 'Preparing');
    $('#export-video').disabled = true;

    try {
        audioControl.pause();
        audioControl.useFileInput();
        audioControl.setLoop(false);
        audioControl.setMuted(true);
        audioControl.setCurrentTime(startTime);

        if (resolution.changed) {
            sketch.setDrawingBufferSize(resolution.width, resolution.height);
            await nextFrames(2);
        }

        const canvasStream = canvas.captureStream(fps);
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
        setExportProgress(true, 0, 'Recording');

        await new Promise((resolve) => {
            const check = () => {
                const progress = clamp((audioControl.currentTime - startTime) / exportDuration, 0, 1);
                setExportProgress(true, progress, cancelRequested ? 'Cancelling' : 'Recording');
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
        canvasStream.getTracks().forEach((track) => track.stop());

        if (!cancelRequested) {
            setExportProgress(true, 1, 'Finalizing');
            const blob = new Blob(chunks, { type: mimeType });
            const actualExtension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
            downloadBlob(blob, `${safeFilename($('#export-filename').value)}.${actualExtension}`);
            toast('Video export complete');
        } else {
            toast('Video export cancelled');
        }
    } catch (error) {
        console.error(error);
        toast('Video export failed');
        setStatus('Export failed', 'error');
    } finally {
        activeRecorder = null;
        if (resolution.changed) {
            sketch.restoreDisplayResolution();
            await nextFrames(1);
            fitViewport();
        }
        audioControl.audioElement.loop = previous.nativeLoop;
        audioControl.setMuted(previous.muted);
        audioControl.setCurrentTime(previous.time);
        loopController.syncButton();
        if (previous.playing) {
            try { await audioControl.play(); } catch (_) {}
        }
        $('#export-video').disabled = false;
        setExportProgress(false);
        setStatus(cancelRequested ? 'Export cancelled' : 'Visualizer ready');
    }
});

$('#cancel-export').addEventListener('click', () => {
    cancelRequested = true;
    if (activeRecorder && activeRecorder.state === 'paused') activeRecorder.resume();
});

$('#export-png').addEventListener('click', async () => {
    const resolution = getExportResolution();
    setStatus('Exporting PNG', 'busy');
    try {
        if (resolution.changed) {
            sketch.setDrawingBufferSize(resolution.width, resolution.height);
            await nextFrames(2);
        }
        const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG capture failed')), 'image/png'));
        downloadBlob(blob, `${safeFilename($('#export-filename').value)}.png`);
        toast('PNG exported');
    } catch (error) {
        console.error(error);
        toast('PNG export failed');
    } finally {
        if (resolution.changed) {
            sketch.restoreDisplayResolution();
            fitViewport();
        }
        setStatus('Visualizer ready');
    }
});

$('#export-json').addEventListener('click', () => {
    const payload = {
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
        export: {
            format: $('#export-format').value,
            resolution: $('#export-resolution').value,
            fps: Number($('#export-fps').value),
            bitrate: Number($('#export-bitrate').value),
            range: $('#export-range').value,
            filename: $('#export-filename').value,
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${safeFilename($('#export-filename').value)}.json`);
    toast('Settings JSON exported');
});

const mp4Option = $('#export-format').querySelector('option[value="mp4"]');
if (window.MediaRecorder && !getMime('mp4')) {
    mp4Option.disabled = true;
    mp4Option.textContent = 'MP4 (unsupported)';
}

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
    }
    requestAnimationFrame(updateUI);
}
requestAnimationFrame(updateUI);

setStatus('Visualizer ready');

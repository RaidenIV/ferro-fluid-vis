import { Sketch } from './sketch-04.js';
import { AudioControl } from './audio-control.js';

const isDev = false;
const audioControl = new AudioControl(isDev);
const canvas = document.querySelector('#visualizer-canvas');
const viewport = document.querySelector('#viewport');
let sketch = null;
let toastTimer = null;
let activeRecorder = null;
let cancelRequested = false;

const $ = (selector) => document.querySelector(selector);
const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

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

function resize() {
    if (sketch) sketch.resize();
}

sketch = new Sketch(
    canvas,
    audioControl,
    (instance) => instance.run(performance.now()),
    () => setStatus('Visualizer ready'),
    isDev,
    null
);

const resizeObserver = new ResizeObserver(() => resize());
resizeObserver.observe(viewport);
window.addEventListener('resize', resize);
resize();

document.querySelectorAll('[data-section-toggle]').forEach((button) => {
    button.addEventListener('click', () => button.closest('[data-section]').classList.toggle('open'));
});

$('#sidebar-toggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    $('#sidebar-toggle').textContent = collapsed ? '›' : '‹';
    setTimeout(resize, 220);
});

function bindRange(id, outputId, handler, formatter = (v) => String(v)) {
    const input = $(`#${id}`);
    const output = outputId ? $(`#${outputId}`) : null;
    const apply = () => {
        const value = Number(input.value);
        if (output) output.textContent = formatter(value);
        handler(value);
    };
    input.addEventListener('input', apply);
    apply();
}

// Playback
$('#load-audio').addEventListener('click', () => $('#audio-file').click());
$('#audio-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus('Loading audio', 'busy');
    try {
        await audioControl.loadFile(file);
        audioControl.setLoop($('#loop-audio').checked);
        audioControl.setVolume(Number($('#volume').value));
        audioControl.setMuted($('#mute-audio').checked);
        $('#track-name').textContent = file.name;
        $('#timeline').disabled = false;
        $('#timeline').max = String(audioControl.duration || 1);
        $('#play-pause').disabled = false;
        $('#reset-audio').disabled = false;
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

$('#play-pause').addEventListener('click', async () => {
    try {
        if (audioControl.isPlaying) audioControl.pause();
        else await audioControl.play();
    } catch (error) {
        console.error(error);
        setStatus('Playback failed', 'error');
    }
});

$('#reset-audio').addEventListener('click', () => audioControl.resetPlayback());
$('#timeline').addEventListener('input', (e) => audioControl.setCurrentTime(Number(e.target.value)));
$('#loop-audio').addEventListener('change', (e) => audioControl.setLoop(e.target.checked));
$('#mute-audio').addEventListener('change', (e) => audioControl.setMuted(e.target.checked));
bindRange('volume', 'volume-value', (v) => audioControl.setVolume(v), (v) => `${Math.round(v * 100)}%`);

$('#microphone').addEventListener('click', async () => {
    setStatus('Requesting microphone', 'busy');
    try {
        await audioControl.initMicrophone();
        setStatus('Microphone active');
        toast('Microphone input active');
    } catch (error) {
        console.error(error);
        setStatus('Microphone unavailable', 'error');
        toast('Microphone permission denied');
    }
});

// Audio analysis
$('#reactive-enabled').addEventListener('change', (e) => sketch.setAudioReactiveSettings({ enabled: e.target.checked }));
$('#reaction-band').addEventListener('change', (e) => sketch.setAudioReactiveSettings({ band: e.target.value }));
$('#fft-size').addEventListener('change', (e) => audioControl.setFFTSize(Number(e.target.value)));
bindRange('sensitivity', 'sensitivity-value', (v) => audioControl.setSensitivity(v), (v) => `${v.toFixed(2)}×`);
bindRange('smoothing', 'smoothing-value', (v) => audioControl.setSmoothing(v), (v) => `${Math.round(v * 100)}%`);
bindRange('threshold', 'threshold-value', (v) => audioControl.setThreshold(v), (v) => v.toFixed(3));

// Ferrofluid reactivity
bindRange('base-zoom', 'base-zoom-value', (v) => sketch.setBaseZoom(v), (v) => v.toFixed(2));
bindRange('spike-height', 'spike-height-value', (v) => sketch.setAudioReactiveSettings({ spikeHeight: v }), (v) => `${v.toFixed(2)}×`);
bindRange('spike-sharpness', 'spike-sharpness-value', (v) => sketch.setAudioReactiveSettings({ spikeSharpness: v }), (v) => `${v.toFixed(2)}×`);
bindRange('agitation', 'agitation-value', (v) => sketch.setAudioReactiveSettings({ agitation: v }), (v) => `${v.toFixed(2)}×`);
bindRange('camera-pulse', 'camera-pulse-value', (v) => sketch.setAudioReactiveSettings({ cameraZoom: v }), (v) => `${v.toFixed(2)}×`);

// Simulation
bindRange('mass', 'mass-value', (v) => sketch.setSimulationSettings({ MASS: v }), (v) => v.toFixed(2));
bindRange('density', 'density-value', (v) => sketch.setSimulationSettings({ REST_DENS: v }), (v) => v.toFixed(2));
bindRange('gas', 'gas-value', (v) => sketch.setSimulationSettings({ GAS_CONST: v }), (v) => v.toFixed(0));
bindRange('viscosity', 'viscosity-value', (v) => sketch.setSimulationSettings({ VISC: v }), (v) => v.toFixed(1));
bindRange('steps', 'steps-value', (v) => sketch.setSimulationSettings({ STEPS: v }), (v) => v.toFixed(0));
bindRange('pointer-radius', 'pointer-radius-value', (v) => sketch.setPointerSettings({ RADIUS: v }), (v) => v.toFixed(2));
bindRange('pointer-strength', 'pointer-strength-value', (v) => sketch.setPointerSettings({ STRENGTH: v }), (v) => v.toFixed(0));

// Camera
bindRange('yaw', 'yaw-value', (v) => sketch.setCameraSettings({ yaw: v }), (v) => `${v.toFixed(1)}°`);
bindRange('elevation', 'elevation-value', (v) => sketch.setCameraSettings({ elevation: v }), (v) => `${v.toFixed(1)}°`);
bindRange('distance', 'distance-value', (v) => sketch.setCameraSettings({ distance: v }), (v) => v.toFixed(2));
$('#auto-rotate').addEventListener('change', (e) => sketch.setCameraSettings({ autoRotate: e.target.checked }));
bindRange('rotate-speed', 'rotate-speed-value', (v) => sketch.setCameraSettings({ rotateSpeed: v }), (v) => `${v.toFixed(1).replace('.0', '')}°/s`);
$('#reset-camera').addEventListener('click', () => {
    sketch.resetCamera();
    syncCameraUI();
    toast('Visualization centered');
});

// Appearance
$('#background-color').addEventListener('input', (e) => sketch.setAppearanceSettings({ backgroundColor: e.target.value }));
bindRange('brightness', 'brightness-value', (v) => sketch.setAppearanceSettings({ materialBrightness: v }), (v) => `${v.toFixed(2)}×`);
bindRange('iridescence', 'iridescence-value', (v) => sketch.setAppearanceSettings({ iridescence: v }), (v) => `${v.toFixed(2)}×`);

function syncCameraUI() {
    const c = sketch.cameraControls;
    const pairs = [
        ['yaw', 'yaw-value', c.yaw, `${c.yaw.toFixed(1)}°`],
        ['elevation', 'elevation-value', c.elevation, `${c.elevation.toFixed(1)}°`],
        ['distance', 'distance-value', c.distance, c.distance.toFixed(2)],
    ];
    pairs.forEach(([id, out, value, label]) => {
        const input = $(`#${id}`);
        if (document.activeElement !== input) input.value = String(value);
        $(`#${out}`).textContent = label;
    });
    $('#auto-rotate').checked = Boolean(c.autoRotate);
}

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
    $('#export-progress-bar').style.width = `${pct * 100}%`;
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
        loop: audioControl.audioElement.loop,
        muted: audioControl.monitorMuted,
    };
    const rangeMode = $('#export-range').value;
    const startTime = rangeMode === 'current' ? Math.min(previous.time, Math.max(0, duration - 0.05)) : 0;
    const endTime = duration;
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
        audioControl.setMuted(true); // monitor only; capture output remains full level
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
        tracks.forEach((track) => {
            if (canvasStream.getTracks().includes(track)) track.stop();
        });

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
        }
        audioControl.setLoop(previous.loop);
        audioControl.setMuted(previous.muted);
        audioControl.setCurrentTime(previous.time);
        if (previous.playing) {
            try { await audioControl.play(); } catch (_) {}
        }
        $('#export-video').disabled = false;
        setExportProgress(false);
        if (!cancelRequested) setStatus('Visualizer ready');
        else setStatus('Export cancelled');
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
        if (resolution.changed) sketch.restoreDisplayResolution();
        setStatus('Visualizer ready');
    }
});

$('#export-json').addEventListener('click', () => {
    const payload = {
        schemaVersion: 1,
        app: 'ferrofluid-audio-reactive',
        defaultsSource: 'ferrofluid-audio-reactive-v1',
        settings: sketch.getSerializableState(),
        audio: {
            fftSize: Number($('#fft-size').value),
            sensitivity: audioControl.sensitivity,
            smoothing: audioControl.smoothing,
            threshold: audioControl.threshold,
            loop: $('#loop-audio').checked,
            volume: Number($('#volume').value),
            muted: $('#mute-audio').checked,
        },
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

// Disable MP4 in browsers that expose MediaRecorder but cannot record MP4.
const mp4Option = $('#export-format').querySelector('option[value="mp4"]');
if (window.MediaRecorder && !getMime('mp4')) {
    mp4Option.disabled = true;
    mp4Option.textContent = 'MP4 (unsupported)';
}

// Keep playback, meters, and camera UI synchronized with runtime state.
let lastUiUpdate = 0;
function updateUI(time) {
    if (time - lastUiUpdate > 50) {
        lastUiUpdate = time;
        if (audioControl.isFileLoaded) {
            const timeline = $('#timeline');
            if (document.activeElement !== timeline && !activeRecorder) timeline.value = String(audioControl.currentTime);
            $('#time-readout').textContent = `${formatTime(audioControl.currentTime)} / ${formatTime(audioControl.duration)}`;
            $('#play-pause').textContent = audioControl.isPlaying ? 'Pause' : 'Play';
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

setStatus('Initializing', 'busy');

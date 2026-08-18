import { clamp } from './utils.js';

export class AudioControl {
    FFT_BUFFER_SIZE = 2048;

    constructor(isDev = false) {
        this.isDev = isDev;
        this.audioContext = null;
        this.analyser = null;
        this.frequencyData = null;
        this.timeData = null;
        this.mediaElementSource = null;
        this.activeAnalysisSource = null;
        this.captureDestination = null;
        this.playbackGain = null;
        this.isInitialized = false;
        this.isFileLoaded = false;
        this.fileName = '';
        this.decodedAudioBuffer = null;
        this.sensitivity = 1.35;
        this.smoothing = 0.72;
        this.threshold = 0.025;
        this.responseCurves = { overall: 'linear', bass: 'linear', mids: 'linear', treble: 'linear' };
        this.attackMs = 22;
        this.releaseMs = 180;
        this.transientImpact = 0.35;
        this.smoothed = { overall: 0, bass: 0, mids: 0, treble: 0 };
        this.transientEnvelope = 0;
        this.transientBaseline = 0;
        this.lastAnalysisTime = performance.now();
        this.offlineEnvelope = null;
        this.offlineEnvelopePromise = null;
        // Reused analysis frame and precomputed FFT band ranges avoid per-frame
        // object/function allocation in the render loop.
        this.analysisFrame = { overall: 0, bass: 0, mids: 0, treble: 0, transient: 0 };
        this.bandRanges = { overall: [0, 0], bass: [0, 0], mids: [0, 0], treble: [0, 0] };
        this.monitorVolume = 0.85;
        this.monitorMuted = false;

        this.audioElement = new Audio();
        this.audioElement.preload = 'auto';
        this.audioElement.crossOrigin = 'anonymous';

        if (isDev) this.#createDebugVisualizer();
    }

    #createDebugVisualizer() {
        this.visualizerElm = document.createElement('canvas');
        this.visualizerElm.width = 220;
        this.visualizerElm.height = 90;
        Object.assign(this.visualizerElm.style, {
            position: 'absolute',
            top: '12px',
            left: '360px',
            width: '220px',
            height: '90px',
            zIndex: 30,
            pointerEvents: 'none',
        });
        this.visualizerCtx = this.visualizerElm.getContext('2d');
        document.body.appendChild(this.visualizerElm);
    }

    async ensureContext() {
        if (!this.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContextClass();
            this.analyser = this.audioContext.createAnalyser();
            this.captureDestination = this.audioContext.createMediaStreamDestination();
            this.playbackGain = this.audioContext.createGain();
            this.playbackGain.gain.value = this.monitorMuted ? 0 : this.monitorVolume;
            this.playbackGain.connect(this.audioContext.destination);
            this.#configureAnalyser(this.FFT_BUFFER_SIZE);

            this.mediaElementSource = this.audioContext.createMediaElementSource(this.audioElement);
            this.mediaElementSource.connect(this.playbackGain);
            this.mediaElementSource.connect(this.captureDestination);
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        this.isInitialized = true;
        return this.audioContext;
    }

    #configureAnalyser(size) {
        if (!this.analyser) return;
        const legalSizes = [256, 512, 1024, 2048, 4096, 8192, 16384];
        this.FFT_BUFFER_SIZE = legalSizes.includes(Number(size)) ? Number(size) : 2048;
        this.analyser.fftSize = this.FFT_BUFFER_SIZE;
        this.analyser.minDecibels = -92;
        this.analyser.maxDecibels = -12;
        this.analyser.smoothingTimeConstant = 0;
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
        this.timeData = new Uint8Array(this.analyser.fftSize);
        this.#updateBandRanges();
    }


    #updateBandRanges() {
        if (!this.analyser || !this.audioContext || !this.frequencyData?.length) return;
        const nyquist = this.audioContext.sampleRate / 2;
        const binHz = nyquist / this.frequencyData.length;
        const range = (lowHz, highHz) => [
            Math.max(0, Math.floor(lowHz / binHz)),
            Math.min(this.frequencyData.length - 1, Math.ceil(highHz / binHz)),
        ];
        this.bandRanges.overall = range(30, 12000);
        this.bandRanges.bass = range(30, 250);
        this.bandRanges.mids = range(250, 2200);
        this.bandRanges.treble = range(2200, 12000);
    }

    #bandRms(range) {
        let sumSq = 0;
        let count = 0;
        const start = range[0];
        const end = range[1];
        for (let i = start; i <= end; i++) {
            const n = this.frequencyData[i] / 255;
            sumSq += n * n;
            count++;
        }
        return count ? Math.sqrt(sumSq / count) : 0;
    }

    #applyResponseCurve(value, curve) {
        const x = clamp(value, 0, 1);
        switch (curve) {
            case 'smooth': return x * x * (3 - 2 * x);
            case 'punchy': return clamp(Math.pow(Math.max(0, (x - 0.06) / 0.94), 0.68), 0, 1);
            case 'exponential': return x * x;
            default: return x;
        }
    }

    #smoothBand(key, rawValue) {
        const gated = Math.max(0, rawValue - this.threshold) / Math.max(0.001, 1 - this.threshold);
        const boosted = clamp(gated * this.sensitivity, 0, 1);
        const curved = this.#applyResponseCurve(boosted, this.responseCurves[key]);
        const alpha = 1 - this.smoothing;
        this.smoothed[key] += (curved - this.smoothed[key]) * alpha;
        this.analysisFrame[key] = this.smoothed[key];
        return curved;
    }

    #updateTransient(overallValue) {
        const now = performance.now();
        const dt = Math.max(1, Math.min(100, now - this.lastAnalysisTime));
        this.lastAnalysisTime = now;
        const baselineRate = 1 - Math.exp(-dt / Math.max(40, this.releaseMs * 1.8));
        this.transientBaseline += (overallValue - this.transientBaseline) * baselineRate;
        const onset = Math.max(0, overallValue - this.transientBaseline);
        const timeConstant = onset > this.transientEnvelope ? this.attackMs : this.releaseMs;
        const rate = 1 - Math.exp(-dt / Math.max(1, timeConstant));
        this.transientEnvelope += (onset - this.transientEnvelope) * rate;
        this.analysisFrame.transient = clamp(this.transientEnvelope * 3.2, 0, 1);
    }

    setFFTSize(size) {
        this.FFT_BUFFER_SIZE = Number(size);
        if (this.analyser) this.#configureAnalyser(this.FFT_BUFFER_SIZE);
    }

    setSensitivity(value) {
        this.sensitivity = Number(value);
    }

    setSmoothing(value) {
        this.smoothing = clamp(Number(value), 0, 0.98);
    }

    setThreshold(value) {
        this.threshold = clamp(Number(value), 0, 0.5);
    }

    setResponseCurve(key, curve) {
        if (!(key in this.responseCurves)) return;
        if (!['linear', 'smooth', 'punchy', 'exponential'].includes(curve)) return;
        this.responseCurves[key] = curve;
    }

    setAttack(value) {
        this.attackMs = clamp(Number(value), 1, 500);
    }

    setRelease(value) {
        this.releaseMs = clamp(Number(value), 20, 1500);
    }

    setTransientImpact(value) {
        this.transientImpact = clamp(Number(value), 0, 2);
    }

    async loadFile(file) {
        if (!file) return;
        await this.ensureContext();
        this.pause();

        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = URL.createObjectURL(file);
        this.audioElement.src = this.objectUrl;
        this.audioElement.load();
        this.fileName = file.name;
        this.isFileLoaded = true;
        this.decodedAudioBuffer = null;
        this.offlineEnvelope = null;
        this.offlineEnvelopePromise = null;
        this.#useAnalysisSource(this.mediaElementSource);

        const metadataReady = new Promise((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('Unable to decode the selected audio file.'));
            };
            const cleanup = () => {
                this.audioElement.removeEventListener('loadedmetadata', onReady);
                this.audioElement.removeEventListener('error', onError);
            };
            this.audioElement.addEventListener('loadedmetadata', onReady, { once: true });
            this.audioElement.addEventListener('error', onError, { once: true });
        });

        const decodeReady = file.arrayBuffer().then((arrayBuffer) =>
            this.audioContext.decodeAudioData(arrayBuffer.slice(0))
        );

        const [, decoded] = await Promise.all([metadataReady, decodeReady]);
        this.decodedAudioBuffer = decoded;
        // Start deterministic envelope preparation without blocking playback.
        this.prepareDeterministicAnalysis().catch(() => {});
    }

    useFileInput() {
        if (!this.isFileLoaded || !this.mediaElementSource) return;
        this.#useAnalysisSource(this.mediaElementSource);
    }

    #useAnalysisSource(source) {
        if (this.activeAnalysisSource === source) return;
        if (this.activeAnalysisSource) {
            try { this.activeAnalysisSource.disconnect(this.analyser); } catch (_) {}
        }
        source.connect(this.analyser);
        this.activeAnalysisSource = source;
    }

    async play() {
        if (!this.isFileLoaded) return false;
        await this.ensureContext();
        this.useFileInput();
        await this.audioElement.play();
        return true;
    }

    pause() {
        this.audioElement.pause();
    }

    togglePlayback() {
        return this.audioElement.paused ? this.play() : (this.pause(), Promise.resolve(false));
    }

    resetPlayback() {
        if (!this.isFileLoaded) return;
        this.pause();
        this.audioElement.currentTime = 0;
    }

    setCurrentTime(seconds) {
        if (!this.isFileLoaded || !Number.isFinite(this.audioElement.duration)) return;
        this.audioElement.currentTime = clamp(Number(seconds), 0, this.audioElement.duration);
    }

    setLoop(value) {
        this.audioElement.loop = Boolean(value);
    }

    setVolume(value) {
        this.monitorVolume = clamp(Number(value), 0, 1);
        if (this.playbackGain && !this.monitorMuted) this.playbackGain.gain.value = this.monitorVolume;
    }

    setMuted(value) {
        this.monitorMuted = Boolean(value);
        if (this.playbackGain) this.playbackGain.gain.value = this.monitorMuted ? 0 : this.monitorVolume;
    }

    get duration() {
        return Number.isFinite(this.audioElement.duration) ? this.audioElement.duration : 0;
    }

    get currentTime() {
        return this.audioElement.currentTime || 0;
    }

    get isPlaying() {
        return this.isFileLoaded && !this.audioElement.paused && !this.audioElement.ended;
    }

    getCaptureStream() {
        return this.captureDestination?.stream || null;
    }

    getAnalysis() {
        if (!this.analyser || !this.activeAnalysisSource) {
            this.analysisFrame.overall = 0;
            this.analysisFrame.bass = 0;
            this.analysisFrame.mids = 0;
            this.analysisFrame.treble = 0;
            this.analysisFrame.transient = 0;
            return this.analysisFrame;
        }

        this.analyser.getByteFrequencyData(this.frequencyData);
        this.analyser.getByteTimeDomainData(this.timeData);

        let timeSumSq = 0;
        for (let i = 0; i < this.timeData.length; i++) {
            const n = (this.timeData[i] - 128) / 128;
            timeSumSq += n * n;
        }
        const rms = Math.sqrt(timeSumSq / this.timeData.length);

        const overall = Math.max(rms * 1.8, this.#bandRms(this.bandRanges.overall) * 0.82);
        const curvedOverall = this.#smoothBand('overall', overall);
        this.#smoothBand('bass', this.#bandRms(this.bandRanges.bass));
        this.#smoothBand('mids', this.#bandRms(this.bandRanges.mids));
        this.#smoothBand('treble', this.#bandRms(this.bandRanges.treble));
        this.#updateTransient(curvedOverall);

        if (this.isDev) this.visualize();
        return this.analysisFrame;
    }

    // Compatibility with the original sketch API.
    getValue() {
        return this.getAnalysis().overall;
    }

    async prepareDeterministicAnalysis() {
        if (this.offlineEnvelope) return this.offlineEnvelope;
        if (this.offlineEnvelopePromise) return this.offlineEnvelopePromise;
        const buffer = this.decodedAudioBuffer;
        if (!buffer) return null;

        this.offlineEnvelopePromise = (async () => {
            const sampleRate = buffer.sampleRate;
            const hop = Math.max(64, Math.round(sampleRate / 120));
            const frameCount = Math.ceil(buffer.length / hop);
            const overall = new Float32Array(frameCount);
            const bass = new Float32Array(frameCount);
            const mids = new Float32Array(frameCount);
            const treble = new Float32Array(frameCount);
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
            const invChannels = 1 / Math.max(1, channels.length);
            const aBass = 1 - Math.exp(-2 * Math.PI * 250 / sampleRate);
            const aMids = 1 - Math.exp(-2 * Math.PI * 2200 / sampleRate);
            let lpBass = 0;
            let lpMids = 0;
            let sums = [0, 0, 0, 0];
            let samples = 0;
            let frame = 0;
            let maxOverall = 1e-6;
            let maxBass = 1e-6;
            let maxMids = 1e-6;
            let maxTreble = 1e-6;

            for (let i = 0; i < buffer.length; i++) {
                let x = 0;
                for (let c = 0; c < channels.length; c++) x += channels[c][i] || 0;
                x *= invChannels;
                lpBass += aBass * (x - lpBass);
                lpMids += aMids * (x - lpMids);
                const b = lpBass;
                const m = lpMids - lpBass;
                const t = x - lpMids;
                sums[0] += x * x;
                sums[1] += b * b;
                sums[2] += m * m;
                sums[3] += t * t;
                samples++;
                if (samples >= hop || i === buffer.length - 1) {
                    const inv = 1 / Math.max(1, samples);
                    const o = Math.sqrt(sums[0] * inv);
                    const bv = Math.sqrt(sums[1] * inv);
                    const mv = Math.sqrt(sums[2] * inv);
                    const tv = Math.sqrt(sums[3] * inv);
                    overall[frame] = o; bass[frame] = bv; mids[frame] = mv; treble[frame] = tv;
                    maxOverall = Math.max(maxOverall, o); maxBass = Math.max(maxBass, bv);
                    maxMids = Math.max(maxMids, mv); maxTreble = Math.max(maxTreble, tv);
                    frame++;
                    sums = [0, 0, 0, 0];
                    samples = 0;
                }
                if (i > 0 && i % 2000000 === 0) await new Promise(requestAnimationFrame);
            }

            // Normalize conservatively so offline export tracks the same 0..1 scale
            // as the live analyser without forcing every track to peak at 1.
            const normalize = (array, peak, gain) => {
                const scale = Math.min(gain, gain / Math.max(0.18, peak));
                for (let i = 0; i < array.length; i++) array[i] = clamp(array[i] * scale, 0, 1);
            };
            normalize(overall, maxOverall, 2.4);
            normalize(bass, maxBass, 4.0);
            normalize(mids, maxMids, 4.0);
            normalize(treble, maxTreble, 4.0);

            const transientTimes = [];
            let baseline = 0;
            let lastTransientTime = -1;
            for (let i = 0; i < overall.length; i++) {
                baseline += (overall[i] - baseline) * 0.025;
                const onset = overall[i] - baseline;
                const time = i / 120;
                if (onset > 0.085 && time - lastTransientTime > 0.08) {
                    transientTimes.push(time);
                    lastTransientTime = time;
                }
            }

            this.offlineEnvelope = { rate: 120, overall, bass, mids, treble, transientTimes };
            return this.offlineEnvelope;
        })().finally(() => { this.offlineEnvelopePromise = null; });
        return this.offlineEnvelopePromise;
    }

    async createDeterministicAnalysisReader() {
        const envelope = await this.prepareDeterministicAnalysis();
        if (!envelope) return null;
        const state = {
            smoothed: { overall: 0, bass: 0, mids: 0, treble: 0 },
            baseline: 0,
            transient: 0,
            lastIndex: -1,
            frame: { overall: 0, bass: 0, mids: 0, treble: 0, transient: 0 },
        };
        const keys = ['overall', 'bass', 'mids', 'treble'];
        const sampleDt = 1000 / envelope.rate;
        const resetState = () => {
            state.smoothed.overall = 0;
            state.smoothed.bass = 0;
            state.smoothed.mids = 0;
            state.smoothed.treble = 0;
            state.baseline = 0;
            state.transient = 0;
            state.lastIndex = -1;
        };
        const processIndex = (index) => {
            let curvedOverall = 0;
            for (const key of keys) {
                const raw = envelope[key][index] || 0;
                const gated = Math.max(0, raw - this.threshold) / Math.max(0.001, 1 - this.threshold);
                const boosted = clamp(gated * this.sensitivity, 0, 1);
                const curved = this.#applyResponseCurve(boosted, this.responseCurves[key]);
                const smoothAlpha = 1 - Math.pow(this.smoothing, Math.max(0.25, sampleDt / 16.667));
                state.smoothed[key] += (curved - state.smoothed[key]) * smoothAlpha;
                state.frame[key] = state.smoothed[key];
                if (key === 'overall') curvedOverall = curved;
            }
            const baselineRate = 1 - Math.exp(-sampleDt / Math.max(40, this.releaseMs * 1.8));
            state.baseline += (curvedOverall - state.baseline) * baselineRate;
            const onset = Math.max(0, curvedOverall - state.baseline);
            const tc = onset > state.transient ? this.attackMs : this.releaseMs;
            const tr = 1 - Math.exp(-sampleDt / Math.max(1, tc));
            state.transient += (onset - state.transient) * tr;
            state.frame.transient = clamp(state.transient * 3.2, 0, 1);
        };

        return (timeSeconds) => {
            const targetIndex = clamp(Math.round(timeSeconds * envelope.rate), 0, envelope.overall.length - 1);
            // The envelope is processed sequentially rather than sampling only the
            // requested bin. This warms the attack/release/smoothing state from the
            // start of the track, so a loop exported from the middle of a song gets
            // the same deterministic analysis history every time.
            if (targetIndex < state.lastIndex) resetState();
            for (let index = state.lastIndex + 1; index <= targetIndex; index++) processIndex(index);
            state.lastIndex = targetIndex;
            return state.frame;
        };
    }

    async getTransientTimes() {
        const envelope = await this.prepareDeterministicAnalysis();
        return envelope?.transientTimes ? [...envelope.transientTimes] : [];
    }

    getSerializableAnalysisSettings() {
        return {
            responseCurves: { ...this.responseCurves },
            attackMs: this.attackMs,
            releaseMs: this.releaseMs,
            transientImpact: this.transientImpact,
        };
    }

    visualize() {
        if (!this.visualizerCtx || !this.frequencyData) return;
        const ctx = this.visualizerCtx;
        const width = this.visualizerElm.width;
        const height = this.visualizerElm.height;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#090909';
        ctx.fillRect(0, 0, width, height);
        const bars = 64;
        const stride = Math.max(1, Math.floor(this.frequencyData.length / bars));
        const barWidth = width / bars;
        ctx.fillStyle = '#0075ff';
        for (let i = 0; i < bars; i++) {
            const value = this.frequencyData[i * stride] / 255;
            ctx.fillRect(i * barWidth, height - value * height, Math.max(1, barWidth - 1), value * height);
        }
    }
}

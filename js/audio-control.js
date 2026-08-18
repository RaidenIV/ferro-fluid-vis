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
        this.smoothed = { overall: 0, bass: 0, mids: 0, treble: 0 };
        // Reused analysis frame and precomputed FFT band ranges avoid per-frame
        // object/function allocation in the render loop.
        this.analysisFrame = { overall: 0, bass: 0, mids: 0, treble: 0 };
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

    #smoothBand(key, rawValue) {
        const gated = Math.max(0, rawValue - this.threshold) / Math.max(0.001, 1 - this.threshold);
        const boosted = clamp(gated * this.sensitivity, 0, 1);
        const alpha = 1 - this.smoothing;
        this.smoothed[key] += (boosted - this.smoothed[key]) * alpha;
        this.analysisFrame[key] = this.smoothed[key];
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
        this.#smoothBand('overall', overall);
        this.#smoothBand('bass', this.#bandRms(this.bandRanges.bass));
        this.#smoothBand('mids', this.#bandRms(this.bandRanges.mids));
        this.#smoothBand('treble', this.#bandRms(this.bandRanges.treble));

        if (this.isDev) this.visualize();
        return this.analysisFrame;
    }

    // Compatibility with the original sketch API.
    getValue() {
        return this.getAnalysis().overall;
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

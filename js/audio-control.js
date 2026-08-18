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
        this.microphoneSource = null;
        this.microphoneStream = null;
        this.activeAnalysisSource = null;
        this.captureDestination = null;
        this.playbackGain = null;
        this.inputType = 'none';
        this.isInitialized = false;
        this.isFileLoaded = false;
        this.fileName = '';
        this.sensitivity = 1.35;
        this.smoothing = 0.72;
        this.threshold = 0.025;
        this.smoothed = { overall: 0, bass: 0, mids: 0, treble: 0 };
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
        this.stopMicrophone();
        this.pause();

        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = URL.createObjectURL(file);
        this.audioElement.src = this.objectUrl;
        this.audioElement.load();
        this.fileName = file.name;
        this.isFileLoaded = true;
        this.#useAnalysisSource(this.mediaElementSource, 'file');

        await new Promise((resolve, reject) => {
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
    }

    async init() {
        return this.initMicrophone();
    }

    async initMicrophone() {
        await this.ensureContext();
        this.pause();
        this.stopMicrophone();

        this.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                autoGainControl: false,
                noiseSuppression: false,
            },
        });
        this.microphoneSource = this.audioContext.createMediaStreamSource(this.microphoneStream);
        this.microphoneSource.connect(this.captureDestination);
        this.#useAnalysisSource(this.microphoneSource, 'microphone');
        return this.microphoneStream;
    }

    stopMicrophone() {
        if (this.inputType === 'microphone' && this.activeAnalysisSource) {
            try { this.activeAnalysisSource.disconnect(this.analyser); } catch (_) {}
            this.activeAnalysisSource = null;
        }
        if (this.microphoneSource) {
            try { this.microphoneSource.disconnect(); } catch (_) {}
            this.microphoneSource = null;
        }
        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach((track) => track.stop());
            this.microphoneStream = null;
        }
        if (this.inputType === 'microphone') this.inputType = 'none';
    }

    useFileInput() {
        if (!this.isFileLoaded || !this.mediaElementSource) return;
        this.stopMicrophone();
        this.#useAnalysisSource(this.mediaElementSource, 'file');
    }

    #useAnalysisSource(source, type) {
        if (this.activeAnalysisSource === source && this.inputType === type) return;
        if (this.activeAnalysisSource) {
            try { this.activeAnalysisSource.disconnect(this.analyser); } catch (_) {}
        }
        source.connect(this.analyser);
        this.activeAnalysisSource = source;
        this.inputType = type;
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
            return { overall: 0, bass: 0, mids: 0, treble: 0 };
        }

        this.analyser.getByteFrequencyData(this.frequencyData);
        this.analyser.getByteTimeDomainData(this.timeData);

        const nyquist = this.audioContext.sampleRate / 2;
        const binHz = nyquist / this.frequencyData.length;
        const band = (lowHz, highHz) => {
            const start = Math.max(0, Math.floor(lowHz / binHz));
            const end = Math.min(this.frequencyData.length - 1, Math.ceil(highHz / binHz));
            let sumSq = 0;
            let count = 0;
            for (let i = start; i <= end; i++) {
                const n = this.frequencyData[i] / 255;
                sumSq += n * n;
                count++;
            }
            return count ? Math.sqrt(sumSq / count) : 0;
        };

        let timeSumSq = 0;
        for (let i = 0; i < this.timeData.length; i++) {
            const n = (this.timeData[i] - 128) / 128;
            timeSumSq += n * n;
        }
        const rms = Math.sqrt(timeSumSq / this.timeData.length);

        const raw = {
            overall: Math.max(rms * 1.8, band(30, 12000) * 0.82),
            bass: band(30, 250),
            mids: band(250, 2200),
            treble: band(2200, 12000),
        };

        const alpha = 1 - this.smoothing;
        Object.keys(raw).forEach((key) => {
            const gated = Math.max(0, raw[key] - this.threshold) / Math.max(0.001, 1 - this.threshold);
            const boosted = clamp(gated * this.sensitivity, 0, 1);
            this.smoothed[key] += (boosted - this.smoothed[key]) * alpha;
        });

        if (this.isDev) this.visualize();
        return { ...this.smoothed };
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

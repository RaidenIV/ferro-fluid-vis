import { mat4, vec2, vec3, vec4 } from "gl-matrix";
import { filter, fromEvent, merge, take, throwIfEmpty } from "rxjs";
import * as twgl from "twgl.js";

import drawVert from './shader/draw.vert.glsl.js';
import drawFrag from './shader/draw.frag.glsl.js';
import integrateVert from './shader/integrate.vert.glsl.js';
import integrateFrag from './shader/integrate.frag.glsl.js';
import pressureVert from './shader/pressure.vert.glsl.js';
import pressureFrag from './shader/pressure.frag.glsl.js';
import forceVert from './shader/force.vert.glsl.js';
import forceFrag from './shader/force.frag.glsl.js';
import indicesVert from './shader/indices.vert.glsl.js';
import indicesFrag from './shader/indices.frag.glsl.js';
import sortVert from './shader/sort.vert.glsl.js';
import sortFrag from './shader/sort.frag.glsl.js';
import offsetVert from './shader/offset.vert.glsl.js';
import offsetFrag from './shader/offset.frag.glsl.js';
import heightMapVert from './shader/height-map.vert.glsl.js';
import heightMapFrag from './shader/height-map.frag.glsl.js';
import postprocessFrag from './shader/postprocess.frag.glsl.js';
import spikesVert from './shader/spikes.vert.glsl.js';
import spikesFrag from './shader/spikes.frag.glsl.js';
import testVert from './shader/test.vert.glsl.js';
import testFrag from './shader/test.frag.glsl.js';
import groundVert from './shader/ground.vert.glsl.js';
import groundFrag from './shader/ground.frag.glsl.js';
import { easeInExpo, easeInOutCubic, easeInOutExpo, easeOutQuint } from "./utils.js";
import {isIOS} from './is-ios.js';

export class Sketch {

    TARGET_FRAME_DURATION = 16;
    #time = 0; // total time
    #deltaTime = 0; // duration betweent the previous and the current animation frame
    #frames = 0; // total framecount according to the target frame duration
    // relative frames according to the target frame duration (1 = 60 fps)
    // gets smaller with higher framerates --> use to adapt animation timing
    #deltaFrames = 0;

    // particle constants
    NUM_PARTICLES = 500;

    // spikes plane properties
    ZOOM = 1;

    // Runtime visual/audio controls. Audio defaults affect the ferrofluid itself, not the camera.
    baseZoom = 0.5;
    audioLevels = { overall: 0, bass: 0, mids: 0, treble: 0, transient: 0 };
    audioReactive = {
        enabled: true,
        band: 'overall',
        spikeHeight: 1.35,
        spikeSharpness: 0.45,
        agitation: 0.65,
        cameraZoom: 0,
        transientImpact: 0.35,
        regionMapping: false,
        regionStrength: 0.85,
        movementMapping: true,
        bassPush: 1,
        midRotation: 1,
        trebleTurbulence: 1,
    };
    appearance = {
        backgroundColor: '#0d0d0d',
        materialBrightness: 1,
        iridescence: 1,
        environmentPreset: 'black-studio',
        roughness: 1,
        metallic: 1,
        reflectionIntensity: 1,
        fresnelStrength: 1,
        environmentIntensity: 1,
        highlightContrast: 1,
        bloomEnabled: false,
        bloomStrength: 0.7,
        bloomThreshold: 0.78,
        bloomRadius: 1.2,
    };
    cameraControls = {
        yaw: 0,
        elevation: 26.565,
        distance: 1.118034,
        autoRotate: false,
        rotateSpeed: 8,
        movementPreset: 'static',
        smoothing: 0.18,
    };
    cameraTarget = { yaw: 0, elevation: 26.565, distance: 1.118034 };
    cameraMotionPhase = 0;
    manualFrameMode = false;
    externalAnalysisFrame = null;
    contextLost = false;
    pausedForVisibility = false;
    eventsInitialized = false;
    exportResolution = null;

    // Performance controls keep the expensive fluid surface pass independent
    // from the display/export resolution. Ultra reproduces the original
    // 256px height-map quality; lower presets reduce only the internal surface
    // field resolution.
    performanceSettings = {
        mode: 'auto',
        simulationQuality: 'ultra',
        renderScale: 1,
        adaptiveSimulation: true,
        fpsLimit: 60,
        showStats: false,
        exportMode: false,
    };
    performanceStats = {
        fps: 60,
        frameMs: 16.67,
        simulationMs: 0,
        renderMs: 0,
        effectiveQuality: 'ultra',
        effectiveRenderScale: 1,
        effectiveSteps: 1,
        simulationHz: 60,
        showStats: false,
    };
    qualityProfiles = {
        // Surface-field and visible mesh resolution are coupled per preset so
        // selecting a higher Simulation Quality actually increases the detail
        // of the rendered ferrofluid rather than only the hidden height map.
        low: { surfaceResolution: 128, meshResolution: 128 },
        medium: { surfaceResolution: 160, meshResolution: 160 },
        high: { surfaceResolution: 208, meshResolution: 208 },
        ultra: { surfaceResolution: 256, meshResolution: 256 },
    };
    qualityOrder = ['low', 'medium', 'high', 'ultra'];
    effectiveQuality = 'ultra';
    effectiveRenderScale = 1;
    autoQualityIndex = 3;
    autoRenderScale = 1;
    lastAutoTuneTime = 0;
    lastProcessedFrameTime = 0;
    drawingBufferOverride = false;

    // Visible ferrofluid surface tessellation. Ultra starts at 256 segments
    // so sharp spike tips are not limited by the old fixed 128-segment mesh.
    planeResolution = 256;
    spikesIndexType = null;

    // entry animation properties
    entryDelay = 120; // frames
    entryDuration = 420; // frames
    entryProgress = 0;
    isEntryAnimationDone = false;

    simulationParams = {
        H: 1, // kernel radius
        MASS: 1, // particle mass
        REST_DENS: 1.8, // rest density
        GAS_CONST: 40, // gas constant
        VISC: 5.5, // viscosity constant

        // these are calculated from the above constants
        POLY6: 0,
        HSQ: 0,
        SPIKY_GRAD: 0,
        VISC_LAP: 0,

        PARTICLE_COUNT: 0, // TODO use instead of NUM_PARTICLES
        DOMAIN_SCALE: 0,

        STEPS: 0
    };

    pointerParams = {
        RADIUS: 1.1,
        STRENGTH: 15,
    }

    camera = {
        matrix: mat4.create(),
        near: .1,
        far: 5,
        fov: Math.PI / 4,
        aspect: 1,
        position: vec3.fromValues(0, .5, 1),
        up: vec3.fromValues(0, 1, 0),
        matrices: {
            view: mat4.create(),
            projection: mat4.create(),
            inversProjection: mat4.create(),
            inversViewProjection: mat4.create()
        }
    };

    constructor(canvasElm, audioControl, onInit = null, onEntryAnimationDone = null, isDev = false, pane = null) {
        this.canvas = canvasElm;
        this.onInit = onInit;
        this.onEntryAnimationDone = onEntryAnimationDone;
        this.isDev = isDev;
        this.pane = pane;
        this.audioControl = audioControl;
        this.boundRun = (time) => this.run(time);
        this.boundContextLost = (event) => { event.preventDefault(); this.contextLost = true; };
        this.boundContextRestored = () => {
            const state = this.getSerializableState();
            this.contextLost = false;
            this.#init();
            this.applySerializableState(state);
        };
        this.canvas.addEventListener('webglcontextlost', this.boundContextLost, false);
        this.canvas.addEventListener('webglcontextrestored', this.boundContextRestored, false);
        document.addEventListener('visibilitychange', () => {
            this.pausedForVisibility = document.hidden;
            this.#time = performance.now();
            this.lastProcessedFrameTime = 0;
        });

        this.#init();
    }

    run(time = 0) {
        if (this.contextLost || this.pausedForVisibility || this.manualFrameMode) {
            this.#time = time;
            requestAnimationFrame(this.boundRun);
            return;
        }
        if (this.envMapTextureLoaded) {
            const fpsLimit = this.performanceSettings.exportMode ? 0 : Number(this.performanceSettings.fpsLimit);
            const frameInterval = fpsLimit > 0 ? 1000 / fpsLimit : 0;
            if (frameInterval && this.lastProcessedFrameTime && time - this.lastProcessedFrameTime < frameInterval - 0.75) {
                requestAnimationFrame(this.boundRun);
                return;
            }

            const rawDelta = this.#time ? Math.max(0.1, time - this.#time) : this.TARGET_FRAME_DURATION;
            this.#deltaTime = Math.min(50, rawDelta);
            this.#time = time;
            this.lastProcessedFrameTime = time;
            this.#deltaFrames = this.#deltaTime / this.TARGET_FRAME_DURATION;
            this.#frames += this.#deltaFrames;
            this.#updateFrameStats(rawDelta);

            this.#animate(this.#deltaTime);
            const renderStart = performance.now();
            this.#render();
            this.performanceStats.renderMs += (performance.now() - renderStart - this.performanceStats.renderMs) * 0.12;
            this.#autoTunePerformance(time);
        }

        requestAnimationFrame(this.boundRun);
    }

    resize() {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        const clientWidth = Math.max(1, this.canvas.clientWidth);
        const clientHeight = Math.max(1, this.canvas.clientHeight);
        const sizeChanged = this.viewportSize[0] !== clientWidth || this.viewportSize[1] !== clientHeight;
        if (sizeChanged) vec2.set(this.viewportSize, clientWidth, clientHeight);

        // The SPH domain is fixed and intentionally independent of display size.
        if (!this.domainScale) this.domainScale = vec2.fromValues(8, 8);
        if (this.simulationParams.DOMAIN_SCALE !== this.domainScale) {
            this.simulationParams.DOMAIN_SCALE = this.domainScale;
            this.simulationParamsNeedUpdate = true;
        }

        if (!this.drawingBufferOverride) {
            const needsResize = twgl.resizeCanvasToDisplaySize(this.canvas, this.effectiveRenderScale);
            if (needsResize) gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }

        if (sizeChanged || !this.camera.aspect) this.#updateProjectionMatrix(gl);
    }

    #init() {
        this.sceneFBO = null;
        this.sceneAttachments = null;
        this.sceneFBOWidth = 0;
        this.sceneFBOHeight = 0;
        this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });

        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        twgl.addExtensionsToContext(gl);

        this.viewportSize = vec2.fromValues(
            this.canvas.clientWidth,
            this.canvas.clientHeight
        );

        this.#initEnvMap();
        this.#initTextures();

        // Setup Programs
        this.drawPrg = twgl.createProgramInfo(gl, [drawVert, drawFrag]);
        this.integratePrg = twgl.createProgramInfo(gl, [integrateVert, integrateFrag]);
        this.pressurePrg = twgl.createProgramInfo(gl, [pressureVert, pressureFrag]);
        this.forcePrg = twgl.createProgramInfo(gl, [forceVert, forceFrag]);
        this.indicesPrg = twgl.createProgramInfo(gl, [indicesVert, indicesFrag]);
        this.sortPrg = twgl.createProgramInfo(gl, [sortVert, sortFrag]);
        this.offsetPrg = twgl.createProgramInfo(gl, [offsetVert, offsetFrag]);
        this.heightMapPrg = twgl.createProgramInfo(gl, [heightMapVert, heightMapFrag]);
        this.postprocessPrg = twgl.createProgramInfo(gl, [heightMapVert, postprocessFrag]);
        this.spikesPrg = twgl.createProgramInfo(gl, [spikesVert, spikesFrag]);
        this.testPrg = twgl.createProgramInfo(gl, [testVert, testFrag]);
        this.groundPrg = twgl.createProgramInfo(gl, [groundVert, groundFrag]);

        // Setup uinform blocks
        this.simulationParamsUBO = twgl.createUniformBlockInfo(gl, this.pressurePrg, 'u_SimulationParams');
        this.pointerParamsUBO = twgl.createUniformBlockInfo(gl, this.integratePrg, 'u_PointerParams');
        this.simulationParamsNeedUpdate = true;

        // Setup Meshes
        this.quadBufferInfo = twgl.createBufferInfoFromArrays(gl, { a_position: { numComponents: 2, data: [-1, -1, 3, -1, -1, 3] }});
        this.quadVAO = twgl.createVAOAndSetAttributes(gl, this.pressurePrg.attribSetters, this.quadBufferInfo.attribs, this.quadBufferInfo.indices);
        this.postprocessVAO = twgl.createVAOAndSetAttributes(gl, this.postprocessPrg.attribSetters, this.quadBufferInfo.attribs, this.quadBufferInfo.indices);
        this.#rebuildSpikesMesh(this.qualityProfiles[this.effectiveQuality]?.meshResolution || this.planeResolution);
        this.spikesWorldMatrix = mat4.create();
        this.groundBufferInfo = twgl.primitives.createDiscBufferInfo(gl, 1.3, 8);
        this.groundVAO = twgl.createVAOAndSetAttributes(gl, this.groundPrg.attribSetters, this.groundBufferInfo.attribs, this.groundBufferInfo.indices);
        this.groundWorldMatrix = mat4.create();

        // Setup Framebuffers
        this.pressureFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.densityPressure}], this.textureSize, this.textureSize);
        this.forceFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.force}], this.textureSize, this.textureSize);
        this.inFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.position1},{attachment: this.textures.velocity1}], this.textureSize, this.textureSize);
        this.outFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.position2},{attachment: this.textures.velocity2}], this.textureSize, this.textureSize);
        this.indices1FBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.indices1}], this.textureSize, this.textureSize);
        this.indices2FBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.indices2}], this.textureSize, this.textureSize);
        this.offsetFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.offset}], this.cellSideCount, this.cellSideCount);
        this.heightMapFBO = twgl.createFramebufferInfo(gl, [{attachment: this.textures.heightMap}], this.heightMapSize, this.heightMapSize);

        this.#initEvents();
        this.domainScale = vec2.fromValues(8, 8);
        this.simulationParams.DOMAIN_SCALE = this.domainScale;
        this.simulationParamsNeedUpdate = true;
        this.#initReusableUniforms();
        this.#updateBackgroundRgb();
        this.lastActivityTime = performance.now();

        this.#syncCameraFromControls();
        this.#updateSimulationParams();
        this.#initTweakpane();
        this.#updateCameraMatrix();
        this.#updateProjectionMatrix(gl);

        this.resize();

        if (this.onInit) { const callback = this.onInit; this.onInit = null; callback(this); }
    }

    #initEvents() {
        if (this.eventsInitialized) return;
        this.eventsInitialized = true;
        this.isPointerDown = false;
        this.isOrbiting = false;
        this.pointer = vec2.create();
        this.pointerLerp = vec2.create();
        this.pointerLerpPrev = vec2.create();
        this.pointerLerpDelta = vec2.create();
        this.orbitPointer = vec2.create();
        this.screenNdc = vec4.create();
        this.screenWorld = vec4.create();
        this.pointerRay = vec3.create();
        this.pointerIntersection = vec3.create();

        fromEvent(this.canvas, 'contextmenu').subscribe((e) => e.preventDefault());
        fromEvent(this.canvas, 'pointerdown').subscribe((e) => {
            if (e.button === 2 || e.shiftKey) {
                this.isOrbiting = true;
                vec2.set(this.orbitPointer, e.clientX, e.clientY);
                return;
            }
            if (e.button !== 0) return;
            this.isPointerDown = true;
            this.#getNormalizedPointerCoords(e);
            this.#getPointerSpikesPlaneIntersection();
            vec2.copy(this.pointerLerp, this.pointer);
            vec2.copy(this.pointerLerpPrev, this.pointerLerp);
        });
        merge(
            fromEvent(this.canvas, 'pointerup'),
            fromEvent(this.canvas, 'pointerleave')
        ).subscribe(() => {
            this.isPointerDown = false;
            this.isOrbiting = false;
        });
        fromEvent(this.canvas, 'pointermove').subscribe((e) => {
            if (this.isOrbiting) {
                const dx = e.clientX - this.orbitPointer[0];
                const dy = e.clientY - this.orbitPointer[1];
                this.orbitPointer[0] = e.clientX;
                this.orbitPointer[1] = e.clientY;
                this.cameraTarget.yaw += dx * 0.22;
                this.cameraTarget.elevation = Math.max(8, Math.min(72, this.cameraTarget.elevation - dy * 0.18));
                this.cameraControls.movementPreset = 'static';
                return;
            }
            if (!this.isPointerDown) return;
            this.#getNormalizedPointerCoords(e);
            this.#getPointerSpikesPlaneIntersection();
        });
        fromEvent(this.canvas, 'wheel').subscribe((e) => {
            e.preventDefault();
            this.cameraTarget.distance = Math.max(0.72, Math.min(2.4, this.cameraTarget.distance + e.deltaY * 0.0015));
            this.cameraControls.movementPreset = 'static';
        });
    }

    #updateSimulationParams() {
        const sim = this.simulationParams
        sim.HSQ = sim.H * sim.H;
        sim.POLY6 = 315.0 / (64. * Math.PI * Math.pow(sim.H, 9.));
        sim.SPIKY_GRAD = -45.0 / (Math.PI * Math.pow(sim.H, 6.));
        sim.VISC_LAP = 45.0 / (Math.PI * Math.pow(sim.H, 5.));

        this.simulationParamsNeedUpdate = true;
    }

    #getNormalizedPointerCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        vec2.set(
            this.pointer,
            (x / Math.max(1, rect.width)) * 2. - 1,
            (1 - (y / Math.max(1, rect.height))) * 2. - 1
        );
        return this.pointer;
    }

    #initTextures() {
         /** @type {WebGLRenderingContext} */
         const gl = this.gl;

         // get a power of two texture size
         this.textureSize = 2**Math.ceil(Math.log2(Math.sqrt(this.NUM_PARTICLES)));

         // update the particle size to fill the texture space
         this.NUM_PARTICLES = this.textureSize * this.textureSize;
         this.simulationParams.PARTICLE_COUNT = this.NUM_PARTICLES;
         this.simulationParamsNeedUpdate = true;

         console.log('number of particles:', this.NUM_PARTICLES);

         // update the sort params
         this.logNumParticles = Math.log2(this.textureSize);
         this.totalSortSteps = ((this.logNumParticles + this.logNumParticles) * (this.logNumParticles + this.logNumParticles + 1)) / 2;

         // define the cell sizes
         // use a fixed cell side count for this project
         this.cellSideCount = 11;
         this.numCells = this.cellSideCount * this.cellSideCount;

         console.log('number of cells:', this.numCells);

         // Internal surface resolution is independent of the display buffer.
         this.baseHeightMapSize = this.planeResolution * 2;
         this.heightMapSize = this.#getHeightMapSize(this.effectiveQuality);

         const initVelocities = new Float32Array(this.NUM_PARTICLES * 4);
         const initForces = new Float32Array(this.NUM_PARTICLES * 4);
         const initPositions = new Float32Array(this.NUM_PARTICLES * 4);

         for(let i=0; i<this.NUM_PARTICLES; ++i) {
             initVelocities[i * 4 + 0] = 0;
             initVelocities[i * 4 + 1] = 0;
             initPositions[i * 4 + 0] = Math.random() * 2 - 1;
             initPositions[i * 4 + 1] = Math.random() * 2 - 1;
         }

         // empty offset texture
         this.initialOffsetTextureData = new Uint16Array(this.numCells);
         this.initialOffsetTextureData.fill(Number.MAX_VALUE);

         const defaultOptions = {
             width: this.textureSize,
             height: this.textureSize,
             min: gl.NEAREST,
             mag: gl.NEAREST,
             wrap: gl.REPEAT
         }

         const defaultVectorTexOptions = {
             ...defaultOptions,
             format: gl.RGBA,
             internalFormat: gl.RGBA32F,
         }

         const defaultIndicesTexOptions = {
             ...defaultOptions,
             format: gl.RG_INTEGER,
             internalFormat: gl.RG16UI,
             wrap: gl.CLAMP_TO_EDGE
         }

         this.offsetTextureOptions = {
             ...defaultOptions,
             width: this.cellSideCount,
             height: this.cellSideCount,
             format: gl.RED_INTEGER,
             internalFormat: gl.R16UI,
             wrap: gl.CLAMP_TO_EDGE
         }

         this.heightMapTextureOptions = {
             min: isIOS ? gl.NEAREST : gl.LINEAR,
             mag: isIOS ? gl.NEAREST : gl.LINEAR,
             wrap: gl.CLAMP_TO_EDGE,
             format: gl.RED,
             internalFormat: gl.R32F,
         };

         this.textures = twgl.createTextures(gl, {
             densityPressure: {
                 ...defaultOptions,
                 format: gl.RG,
                 internalFormat: gl.RG32F,
                 src: new Float32Array(this.NUM_PARTICLES * 2)
             },
             force: { ...defaultVectorTexOptions, src: [...initForces] },
             position1: { ...defaultVectorTexOptions, src: [...initPositions] },
             position2: { ...defaultVectorTexOptions, src: [...initPositions] },
             velocity1: { ...defaultVectorTexOptions, src: [...initVelocities] },
             velocity2: { ...defaultVectorTexOptions, src: [...initVelocities] },
             indices1: {
                 ...defaultIndicesTexOptions,
                 src: new Uint16Array(this.NUM_PARTICLES * 4)
             },
             indices2: {
                 ...defaultIndicesTexOptions,
                 src: new Uint16Array(this.NUM_PARTICLES * 4)
             },
             offset: {
                 ...this.offsetTextureOptions,
                 src: this.initialOffsetTextureData,
             },
             heightMap: {
                ...this.heightMapTextureOptions,
                width: this.heightMapSize,
                height: this.heightMapSize,
            },
         });

         this.currentPositionTexture = this.textures.position2;
         this.currentVelocityTexture = this.textures.velocity2;
    }

    #initReusableUniforms() {
        this.cellTexSize = [this.cellSideCount, this.cellSideCount];
        this.particleTexSize = [this.textureSize, this.textureSize];
        this.backgroundRgb = new Float32Array(3);
        this.pressureUniforms = {
            u_positionTexture: this.inFBO.attachments[0],
            u_indicesTexture: this.currentIndicesTexture,
            u_offsetTexture: this.textures.offset,
            u_gasConst: this.simulationParams.GAS_CONST,
        };
        this.forceUniforms = {
            u_densityPressureTexture: this.pressureFBO.attachments[0],
            u_positionTexture: this.inFBO.attachments[0],
            u_velocityTexture: this.inFBO.attachments[1],
            u_indicesTexture: this.currentIndicesTexture,
            u_offsetTexture: this.textures.offset,
        };
        this.integrateUniforms = {
            u_positionTexture: this.inFBO.attachments[0],
            u_velocityTexture: this.inFBO.attachments[1],
            u_forceTexture: this.forceFBO.attachments[0],
            u_densityPressureTexture: this.pressureFBO.attachments[0],
            u_pointerPos: this.pointerLerp,
            u_pointerVelocity: this.pointerLerpDelta,
            u_dt: 16,
            u_frames: 0,
            u_zoom: this.ZOOM,
            u_domainScale: this.domainScale,
            u_audioLevel: 0,
            u_audioBass: 0,
            u_audioMids: 0,
            u_audioTreble: 0,
            u_audioAgitation: this.audioReactive.agitation,
            u_audioTransient: 0,
            u_transientImpact: this.audioReactive.transientImpact,
            u_bassPush: this.audioReactive.bassPush,
            u_midRotation: this.audioReactive.midRotation,
            u_trebleTurbulence: this.audioReactive.trebleTurbulence,
        };
        this.indicesUniforms = {
            u_positionTexture: this.currentPositionTexture,
            u_cellTexSize: this.cellTexSize,
            u_cellSize: this.simulationParams.H,
            u_domainScale: this.domainScale,
        };
        this.sortUniforms = {
            u_indicesTexture: this.indices1FBO.attachments[0],
            u_twoStage: 0,
            u_passModStage: 0,
            u_twoStagePmS1: 0,
            u_texSize: this.particleTexSize,
            u_ppass: 0,
        };
        this.offsetUniforms = {
            u_indicesTexture: this.indices1FBO.attachments[0],
            u_texSize: this.cellTexSize,
            u_particleTexSize: this.particleTexSize,
        };
        this.heightMapUniforms = {
            u_particlePosTexture: this.currentPositionTexture,
            u_heightFactor: 0,
            u_scale: 0,
            u_smoothFactor: 0,
            u_spikeFactor: 0,
            u_audioBass: 0,
            u_audioMids: 0,
            u_audioTreble: 0,
            u_regionMapping: 0,
            u_regionStrength: this.audioReactive.regionStrength,
        };
        this.groundUniforms = {
            u_worldMatrix: this.groundWorldMatrix,
            u_viewMatrix: this.camera.matrices.view,
            u_projectionMatrix: this.camera.matrices.projection,
            u_cameraPosition: this.camera.position,
            u_envMapTexture: this.envMapTexture,
            u_zoom: this.ZOOM,
            u_backgroundColor: this.backgroundRgb,
            u_materialBrightness: this.appearance.materialBrightness,
            u_iridescence: this.appearance.iridescence,
            u_roughness: this.appearance.roughness,
            u_metallic: this.appearance.metallic,
            u_reflectionIntensity: this.appearance.reflectionIntensity,
            u_fresnelStrength: this.appearance.fresnelStrength,
            u_environmentIntensity: this.appearance.environmentIntensity,
            u_highlightContrast: this.appearance.highlightContrast,
        };
        this.spikesUniforms = {
            u_worldMatrix: this.spikesWorldMatrix,
            u_viewMatrix: this.camera.matrices.view,
            u_projectionMatrix: this.camera.matrices.projection,
            u_heightMapTexture: this.textures.heightMap,
            u_zoom: this.ZOOM,
            u_cameraPosition: this.camera.position,
            u_envMapTexture: this.envMapTexture,
            u_materialBrightness: this.appearance.materialBrightness,
            u_iridescence: this.appearance.iridescence,
            u_roughness: this.appearance.roughness,
            u_metallic: this.appearance.metallic,
            u_reflectionIntensity: this.appearance.reflectionIntensity,
            u_fresnelStrength: this.appearance.fresnelStrength,
            u_environmentIntensity: this.appearance.environmentIntensity,
            u_highlightContrast: this.appearance.highlightContrast,
        };
        this.postprocessUniforms = {
            u_sceneTexture: null,
            u_texelSize: new Float32Array([1 / Math.max(1, this.gl.drawingBufferWidth), 1 / Math.max(1, this.gl.drawingBufferHeight)]),
            u_bloomStrength: this.appearance.bloomStrength,
            u_bloomThreshold: this.appearance.bloomThreshold,
            u_bloomRadius: this.appearance.bloomRadius,
        };
        this.pointerBlockValues = {
            pointerRadius: this.pointerParams.RADIUS,
            pointerStrength: this.pointerParams.STRENGTH,
            pointerPos: this.pointerLerp,
            pointerVelocity: this.pointerLerpDelta,
        };
    }

    #getHeightMapSize(quality = this.effectiveQuality) {
        const profile = this.qualityProfiles[quality] || this.qualityProfiles.ultra;
        return Math.max(64, Math.round((profile.surfaceResolution || 256) / 16) * 16);
    }

    #disposeBufferInfo(bufferInfo) {
        if (!this.gl || !bufferInfo) return;
        const gl = this.gl;
        const buffers = new Set();
        Object.values(bufferInfo.attribs || {}).forEach((attrib) => {
            if (attrib?.buffer) buffers.add(attrib.buffer);
        });
        if (bufferInfo.indices) buffers.add(bufferInfo.indices);
        buffers.forEach((buffer) => gl.deleteBuffer(buffer));
    }

    #rebuildSpikesMesh(resolution) {
        if (!this.gl || !this.spikesPrg) return;
        const nextResolution = Math.max(32, Math.round(Number(resolution) || 128));
        if (this.spikesVAO) this.gl.deleteVertexArray(this.spikesVAO);
        if (this.spikesBufferInfo) this.#disposeBufferInfo(this.spikesBufferInfo);
        const arrays = twgl.primitives.createPlaneVertices(1, 1, nextResolution, nextResolution);
        this.spikesBufferInfo = twgl.createBufferInfoFromArrays(this.gl, arrays);
        this.spikesVAO = twgl.createVAOAndSetAttributes(
            this.gl,
            this.spikesPrg.attribSetters,
            this.spikesBufferInfo.attribs,
            this.spikesBufferInfo.indices
        );
        this.planeResolution = nextResolution;
        this.spikesIndexType = ((nextResolution + 1) * (nextResolution + 1) > 65535)
            ? this.gl.UNSIGNED_INT
            : this.gl.UNSIGNED_SHORT;
    }

    #rebuildHeightMap(quality) {
        if (!this.gl || !this.textures || !this.heightMapTextureOptions) return;
        const nextSize = this.#getHeightMapSize(quality);
        if (nextSize === this.heightMapSize) return;
        const gl = this.gl;
        if (this.heightMapFBO?.framebuffer) gl.deleteFramebuffer(this.heightMapFBO.framebuffer);
        if (this.textures.heightMap) gl.deleteTexture(this.textures.heightMap);
        this.heightMapSize = nextSize;
        this.textures.heightMap = twgl.createTexture(gl, {
            ...this.heightMapTextureOptions,
            width: nextSize,
            height: nextSize,
        });
        this.heightMapFBO = twgl.createFramebufferInfo(gl, [{ attachment: this.textures.heightMap }], nextSize, nextSize);
        if (this.spikesUniforms) this.spikesUniforms.u_heightMapTexture = this.textures.heightMap;
    }

    #updateBackgroundRgb() {
        if (!this.backgroundRgb) return;
        const clean = String(this.appearance.backgroundColor || '#000000').replace('#', '');
        const value = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
        this.backgroundRgb[0] = parseInt(value.slice(0, 2), 16) / 255;
        this.backgroundRgb[1] = parseInt(value.slice(2, 4), 16) / 255;
        this.backgroundRgb[2] = parseInt(value.slice(4, 6), 16) / 255;
    }

    #updateFrameStats(rawDelta) {
        const fps = 1000 / Math.max(0.1, rawDelta);
        this.performanceStats.fps += (fps - this.performanceStats.fps) * 0.08;
        this.performanceStats.frameMs += (rawDelta - this.performanceStats.frameMs) * 0.08;
    }

    #applyEffectivePerformanceState(quality, renderScale) {
        const normalizedQuality = this.qualityProfiles[quality] ? quality : 'ultra';
        const normalizedScale = Math.max(0.5, Math.min(1, Number(renderScale) || 1));
        const qualityChanged = normalizedQuality !== this.effectiveQuality;
        const scaleChanged = Math.abs(normalizedScale - this.effectiveRenderScale) > 0.001;
        this.effectiveQuality = normalizedQuality;
        this.effectiveRenderScale = normalizedScale;
        this.performanceStats.effectiveQuality = normalizedQuality;
        this.performanceStats.effectiveRenderScale = normalizedScale;
        if (qualityChanged) {
            this.#rebuildHeightMap(normalizedQuality);
            const meshResolution = this.qualityProfiles[normalizedQuality]?.meshResolution || 256;
            this.#rebuildSpikesMesh(meshResolution);
        }
        if (scaleChanged && !this.drawingBufferOverride) this.resize();
    }

    #autoTunePerformance(time) {
        if (this.performanceSettings.mode !== 'auto' || this.performanceSettings.exportMode || !this.isEntryAnimationDone) return;
        if (time - this.lastAutoTuneTime < 1500) return;
        this.lastAutoTuneTime = time;

        const ceiling = Math.max(0, this.qualityOrder.indexOf(this.performanceSettings.simulationQuality));
        this.autoQualityIndex = Math.min(this.autoQualityIndex, ceiling);
        const requestedScale = this.performanceSettings.renderScale;
        const fps = this.performanceStats.fps;
        const configuredLimit = Number(this.performanceSettings.fpsLimit);
        const targetFps = configuredLimit > 0 ? configuredLimit : 60;
        const lowThreshold = targetFps * 0.87;
        const highThreshold = targetFps * 0.97;
        if (typeof document !== 'undefined' && document.hidden) return;

        // Protect simulation fidelity first: lower the internal surface field
        // before reducing display resolution. Restore display resolution first.
        if (fps < lowThreshold) {
            if (this.autoQualityIndex > 0) this.autoQualityIndex--;
            else this.autoRenderScale = Math.max(0.5, Math.round((this.autoRenderScale - 0.1) * 10) / 10);
        } else if (fps > highThreshold) {
            if (this.autoRenderScale < requestedScale - 0.01) {
                this.autoRenderScale = Math.min(requestedScale, Math.round((this.autoRenderScale + 0.1) * 10) / 10);
            } else if (this.autoQualityIndex < ceiling) {
                this.autoQualityIndex++;
            }
        }

        this.#applyEffectivePerformanceState(this.qualityOrder[this.autoQualityIndex], Math.min(requestedScale, this.autoRenderScale));
    }

    #getAdaptiveStepCount() {
        const requestedAdditional = Math.max(0, Math.round(this.simulationParams.STEPS));
        if (!this.performanceSettings.adaptiveSimulation || this.performanceSettings.exportMode || !this.isEntryAnimationDone) return requestedAdditional;
        const qualityFactor = { low: 0.25, medium: 0.5, high: 0.75, ultra: 1 }[this.effectiveQuality] || 1;
        const maxAdditional = Math.ceil(requestedAdditional * qualityFactor);
        const pointerEnergy = Math.min(1, vec2.squaredLength(this.pointerLerpDelta) * 18);
        const audioEnergy = this.audioReactive.enabled ? (this.audioLevels.overall || 0) : 0;
        const activity = Math.max(audioEnergy, this.isPointerDown ? 1 : 0, pointerEnergy);
        if (activity > 0.55) return maxAdditional;
        if (activity > 0.22) return Math.ceil(maxAdditional * 0.75);
        if (activity > 0.06) return Math.ceil(maxAdditional * 0.5);
        return 0;
    }

    #initEnvMap() {
        const gl = this.gl;
        this.envMapTextureLoaded = false;
        this.environmentTextures = {};
        const finishPrimary = () => { this.envMapTextureLoaded = true; };
        this.environmentTextures.studio = twgl.createTexture(gl, {
            src: new URL('../assets/env-map-01.jpg', import.meta.url).toString(),
        }, finishPrimary);
        this.environmentTextures.metallic = twgl.createTexture(gl, {
            src: new URL('../assets/env-map-02.jpg', import.meta.url).toString(),
        });
        this.envMapTexture = this.environmentTextures.studio;
    }

    #initTweakpane() {
        if (!this.pane) return;

        const sim = this.pane.addFolder({ title: 'Simulation' });
        sim.addInput(this.simulationParams, 'MASS', { min: 0.01, max: 5, });
        sim.addInput(this.simulationParams, 'REST_DENS', { min: 0.1, max: 5, });
        sim.addInput(this.simulationParams, 'GAS_CONST', { min: 10, max: 500, });
        sim.addInput(this.simulationParams, 'VISC', { min: 1, max: 20, });
        sim.addInput(this.simulationParams, 'STEPS', { min: 0, max: 6, step: 1 });

        const pointer = this.pane.addFolder({ title: 'Pointer' });
        pointer.addInput(this.pointerParams, 'RADIUS', { min: 0.1, max: 5, });
        pointer.addInput(this.pointerParams, 'STRENGTH', { min: 1, max: 35, });

        //const interaction = this.pane.addFolder({ title: 'Interaction' });
        //interaction.addInput(this, 'ZOOM', { min: 0, max: 1, });

        sim.on('change', () => this.#updateSimulationParams());
        pointer.on('change', () => this.pointerParamsNeedUpdate = true);
    }

    #updatePointer() {
        this.pointerLerp[0] += (this.pointer[0] - this.pointerLerp[0]) / 5;
        this.pointerLerp[1] += (this.pointer[1] - this.pointerLerp[1]) / 5;

        vec2.subtract(this.pointerLerpDelta, this.pointerLerp, this.pointerLerpPrev);
        vec2.copy(this.pointerLerpPrev, this.pointerLerp);
    }

    #simulate(deltaTime) {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        this.#prepare();

        if (this.simulationParamsNeedUpdate) {
            twgl.setBlockUniforms(this.simulationParamsUBO, {
                ...this.simulationParams,
                CELL_TEX_SIZE: this.cellTexSize,
                CELL_SIZE: this.simulationParams.H
            });
            twgl.setUniformBlock(gl, this.pressurePrg, this.simulationParamsUBO);
            twgl.setUniformBlock(gl, this.forcePrg, this.simulationParamsUBO);
            this.simulationParamsNeedUpdate = false;
        } else {
            twgl.bindUniformBlock(gl, this.pressurePrg, this.simulationParamsUBO);
            twgl.bindUniformBlock(gl, this.forcePrg, this.simulationParamsUBO);
        }

        gl.useProgram(this.pressurePrg.program);
        twgl.bindFramebufferInfo(gl, this.pressureFBO);
        gl.bindVertexArray(this.quadVAO);
        this.pressureUniforms.u_positionTexture = this.inFBO.attachments[0];
        this.pressureUniforms.u_indicesTexture = this.currentIndicesTexture;
        this.pressureUniforms.u_gasConst = this.simulationParams.GAS_CONST;
        twgl.setUniforms(this.pressurePrg, this.pressureUniforms);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);

        gl.useProgram(this.forcePrg.program);
        twgl.bindFramebufferInfo(gl, this.forceFBO);
        this.forceUniforms.u_densityPressureTexture = this.pressureFBO.attachments[0];
        this.forceUniforms.u_positionTexture = this.inFBO.attachments[0];
        this.forceUniforms.u_velocityTexture = this.inFBO.attachments[1];
        this.forceUniforms.u_indicesTexture = this.currentIndicesTexture;
        twgl.setUniforms(this.forcePrg, this.forceUniforms);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);

        gl.useProgram(this.integratePrg.program);
        twgl.bindFramebufferInfo(gl, this.outFBO);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const u = this.integrateUniforms;
        u.u_positionTexture = this.inFBO.attachments[0];
        u.u_velocityTexture = this.inFBO.attachments[1];
        u.u_forceTexture = this.forceFBO.attachments[0];
        u.u_densityPressureTexture = this.pressureFBO.attachments[0];
        u.u_dt = deltaTime;
        u.u_frames = this.#frames;
        u.u_zoom = this.ZOOM;
        u.u_audioLevel = this.audioReactive.enabled ? this.audioLevels.overall : 0;
        u.u_audioBass = this.audioReactive.enabled ? this.audioLevels.bass : 0;
        u.u_audioMids = this.audioReactive.enabled ? this.audioLevels.mids : 0;
        u.u_audioTreble = this.audioReactive.enabled ? this.audioLevels.treble : 0;
        u.u_audioAgitation = this.audioReactive.agitation;
        u.u_audioTransient = this.audioReactive.enabled ? (this.audioLevels.transient || 0) : 0;
        u.u_transientImpact = this.audioReactive.transientImpact;
        u.u_bassPush = this.audioReactive.movementMapping ? this.audioReactive.bassPush : 0;
        u.u_midRotation = this.audioReactive.movementMapping ? this.audioReactive.midRotation : 0;
        u.u_trebleTurbulence = this.audioReactive.movementMapping ? this.audioReactive.trebleTurbulence : 0;
        twgl.setUniforms(this.integratePrg, u);

        this.pointerBlockValues.pointerRadius = this.pointerParams.RADIUS;
        this.pointerBlockValues.pointerStrength = this.pointerParams.STRENGTH;
        twgl.setBlockUniforms(this.pointerParamsUBO, this.pointerBlockValues);
        twgl.setUniformBlock(gl, this.integratePrg, this.pointerParamsUBO);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);

        this.currentPositionTexture = this.outFBO.attachments[0];
        this.currentVelocityTexture = this.outFBO.attachments[1];
        const tmp = this.inFBO;
        this.inFBO = this.outFBO;
        this.outFBO = tmp;
    }

    #prepare() {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;

        gl.useProgram(this.indicesPrg.program);
        twgl.bindFramebufferInfo(gl, this.indices1FBO);
        gl.bindVertexArray(this.quadVAO);
        this.indicesUniforms.u_positionTexture = this.currentPositionTexture;
        twgl.setUniforms(this.indicesPrg, this.indicesUniforms);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);

        let sortOutFBO = this.indices1FBO;
        let sortInFBO = this.indices2FBO;
        gl.useProgram(this.sortPrg.program);
        let pass = -1;
        let stage = -1;
        let stepsLeft = this.totalSortSteps;
        const u = this.sortUniforms;
        while (stepsLeft) {
            pass--;
            if (pass < 0) {
                stage++;
                pass = stage;
            }
            const pstage = (1 << stage);
            const ppass = (1 << pass);
            twgl.bindFramebufferInfo(gl, sortInFBO);
            u.u_indicesTexture = sortOutFBO.attachments[0];
            u.u_twoStage = pstage + pstage;
            u.u_passModStage = ppass % pstage;
            u.u_twoStagePmS1 = (pstage + pstage) - (ppass % pstage) - 1;
            u.u_ppass = ppass;
            twgl.setUniforms(this.sortPrg, u);
            twgl.drawBufferInfo(gl, this.quadBufferInfo);
            const tmp = sortOutFBO;
            sortOutFBO = sortInFBO;
            sortInFBO = tmp;
            stepsLeft--;
        }

        gl.useProgram(this.offsetPrg.program);
        twgl.bindFramebufferInfo(gl, this.offsetFBO);
        this.offsetUniforms.u_indicesTexture = sortOutFBO.attachments[0];
        twgl.setUniforms(this.offsetPrg, this.offsetUniforms);
        gl.clearColor(1, 0, 0, 0);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);
        this.currentIndicesTexture = sortOutFBO.attachments[0];
    }

    #renderHeightMap() {
        /** @type {WebGLRenderingContext} */
        const gl = this.gl;
        gl.useProgram(this.heightMapPrg.program);
        twgl.bindFramebufferInfo(gl, this.heightMapFBO);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(this.quadVAO);
        const u = this.heightMapUniforms;
        u.u_particlePosTexture = this.currentPositionTexture;
        const reactiveLevel = this.#getReactiveLevel();
        // The Ferrofluid controls are direct shape controls as well as audio
        // response amounts. Their defaults evaluate to exactly 1.0 here, so
        // the existing default appearance is unchanged, while moving either
        // control now produces an immediate visible result even with audio
        // paused or Audio Reactive disabled.
        const heightControl = Math.max(0, Number(this.audioReactive.spikeHeight) || 0);
        const sharpnessControl = Math.max(0, Number(this.audioReactive.spikeSharpness) || 0);
        const heightBaseMultiplier = heightControl / 1.35;
        const sharpnessBaseMultiplier = sharpnessControl / 0.45;
        u.u_heightFactor = this.#remapZoomForHeight(this.ZOOM) * heightBaseMultiplier * (1 + reactiveLevel * heightControl);
        u.u_scale = this.#remapHeightMapZoomScale(this.ZOOM);
        u.u_smoothFactor = this.#remapSmoothFactorZoom(this.ZOOM);
        u.u_spikeFactor = this.#remapSpikeFactorZoom(this.ZOOM) * sharpnessBaseMultiplier * (1 + reactiveLevel * sharpnessControl);
        u.u_audioBass = this.audioReactive.enabled ? this.audioLevels.bass : 0;
        u.u_audioMids = this.audioReactive.enabled ? this.audioLevels.mids : 0;
        u.u_audioTreble = this.audioReactive.enabled ? this.audioLevels.treble : 0;
        u.u_regionMapping = this.audioReactive.regionMapping ? 1 : 0;
        u.u_regionStrength = this.audioReactive.regionStrength;
        twgl.setUniforms(this.heightMapPrg, u);
        twgl.drawBufferInfo(gl, this.quadBufferInfo);
    }

    #animate(deltaTime) {
        this.#updatePointer();

        if (this.isEntryAnimationDone) {
            this.audioLevels = this.externalAnalysisFrame || this.audioControl.getAnalysis();
            const reactiveLevel = this.#getReactiveLevel();
            this.ZOOM = Math.max(0.05, Math.min(0.95, this.baseZoom - reactiveLevel * this.audioReactive.cameraZoom * 0.18));
        } else {

            if (this.entryProgress >= this.entryDelay) {
                const frameProgress = (this.entryProgress - this.entryDelay);
                const part1 = this.entryDuration * .7;
                const part2 = this.entryDuration - part1;

                // first part of entry animation: rise until peak
                if (frameProgress < part1) {
                    const progress = frameProgress / part1;
                    const t = easeInOutExpo(progress);
                    this.ZOOM = 1 - t;
                } else {
                    const progress = (frameProgress - part1) / part2;
                    const t = easeInOutCubic(progress);
                    this.ZOOM = 0.5 * t;
                }

            }

            this.entryProgress += this.#deltaFrames;

            if (this.entryProgress >= this.entryDuration + this.entryDelay) {
                if (this.onEntryAnimationDone) this.onEntryAnimationDone();
                this.isEntryAnimationDone = true;
                this.ZOOM = this.baseZoom;
                this.lastActivityTime = this.#time;
            }
        }

        this.#updateCameraMotion(deltaTime);

        // Keep the simulation temporally synchronized with every rendered frame.
        // Adaptive Simulation may reduce solver iterations, but it must never
        // reduce the simulation update rate independently of the displayed FPS;
        // doing so makes slow motion visibly stutter even while the renderer is
        // correctly reporting ~60 FPS.
        const simulationStart = performance.now();
        const stableDelta = Math.min(20, Math.max(4, 16 * this.#deltaFrames));
        this.#simulate(stableDelta);
        vec2.set(this.pointerLerpDelta, 0, 0);
        const additionalSteps = this.#getAdaptiveStepCount();
        for (let i = 0; i < additionalSteps; ++i) this.#simulate(stableDelta);
        this.#renderHeightMap();
        const simulationMs = performance.now() - simulationStart;
        this.performanceStats.simulationMs += (simulationMs - this.performanceStats.simulationMs) * 0.12;
        this.performanceStats.effectiveSteps = 1 + additionalSteps;
        this.performanceStats.simulationHz = Math.min(240, 1000 / Math.max(1, deltaTime));
    }

    #ensureSceneFramebuffer() {
        const gl = this.gl;
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (!this.sceneAttachments) {
            this.sceneAttachments = [
                { format: gl.RGBA, internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE, minMag: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE },
                { format: gl.DEPTH_STENCIL, internalFormat: gl.DEPTH24_STENCIL8 },
            ];
        }
        if (!this.sceneFBO) {
            this.sceneFBO = twgl.createFramebufferInfo(gl, this.sceneAttachments, width, height);
            this.sceneFBOWidth = width;
            this.sceneFBOHeight = height;
        } else if (this.sceneFBOWidth !== width || this.sceneFBOHeight !== height) {
            twgl.resizeFramebufferInfo(gl, this.sceneFBO, this.sceneAttachments, width, height);
            this.sceneFBOWidth = width;
            this.sceneFBOHeight = height;
        }
    }

    #applyMaterialUniforms(uniforms) {
        uniforms.u_zoom = this.ZOOM;
        uniforms.u_envMapTexture = this.envMapTexture;
        uniforms.u_materialBrightness = this.appearance.materialBrightness;
        uniforms.u_iridescence = this.appearance.iridescence;
        uniforms.u_roughness = this.appearance.roughness;
        uniforms.u_metallic = this.appearance.metallic;
        uniforms.u_reflectionIntensity = this.appearance.reflectionIntensity;
        uniforms.u_fresnelStrength = this.appearance.fresnelStrength;
        uniforms.u_environmentIntensity = this.appearance.environmentIntensity;
        uniforms.u_highlightContrast = this.appearance.highlightContrast;
    }

    #renderScene(targetFBO = null) {
        const gl = this.gl;
        twgl.bindFramebufferInfo(gl, targetFBO);
        const width = targetFBO?.width || gl.drawingBufferWidth;
        const height = targetFBO?.height || gl.drawingBufferHeight;
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        const bg = this.backgroundRgb;
        gl.clearColor(bg[0], bg[1], bg[2], 1.);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.groundPrg.program);
        this.#applyMaterialUniforms(this.groundUniforms);
        twgl.setUniforms(this.groundPrg, this.groundUniforms);
        gl.bindVertexArray(this.groundVAO);
        gl.drawElements(gl.TRIANGLES, this.groundBufferInfo.numElements, gl.UNSIGNED_SHORT, 0);

        gl.useProgram(this.spikesPrg.program);
        gl.enable(gl.DEPTH_TEST);
        this.spikesUniforms.u_heightMapTexture = this.textures.heightMap;
        this.#applyMaterialUniforms(this.spikesUniforms);
        twgl.setUniforms(this.spikesPrg, this.spikesUniforms);
        gl.bindVertexArray(this.spikesVAO);
        gl.drawElements(
            gl.TRIANGLES,
            this.spikesBufferInfo.numElements,
            this.spikesIndexType || gl.UNSIGNED_SHORT,
            0
        );
    }

    #render() {
        const gl = this.gl;
        if (this.appearance.bloomEnabled) {
            this.#ensureSceneFramebuffer();
            this.#renderScene(this.sceneFBO);
            twgl.bindFramebufferInfo(gl, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.useProgram(this.postprocessPrg.program);
            gl.bindVertexArray(this.postprocessVAO);
            this.postprocessUniforms.u_sceneTexture = this.sceneFBO.attachments[0];
            this.postprocessUniforms.u_texelSize[0] = 1 / Math.max(1, gl.drawingBufferWidth);
            this.postprocessUniforms.u_texelSize[1] = 1 / Math.max(1, gl.drawingBufferHeight);
            this.postprocessUniforms.u_bloomStrength = this.appearance.bloomStrength;
            this.postprocessUniforms.u_bloomThreshold = this.appearance.bloomThreshold;
            this.postprocessUniforms.u_bloomRadius = this.appearance.bloomRadius;
            twgl.setUniforms(this.postprocessPrg, this.postprocessUniforms);
            twgl.drawBufferInfo(gl, this.quadBufferInfo);
        } else {
            this.#renderScene(null);
        }
    }

    setAudioReactiveSettings(partial = {}) {
        const liveFerrofluidKeys = ['spikeHeight', 'spikeSharpness', 'agitation', 'cameraZoom', 'regionStrength', 'bassPush', 'midRotation', 'trebleTurbulence'];
        if (liveFerrofluidKeys.some((key) => Object.prototype.hasOwnProperty.call(partial, key))) {
            this.#finishEntryAnimationForLiveControl();
        }
        Object.assign(this.audioReactive, partial);
    }

    setSimulationSettings(partial = {}) {
        const allowed = ['MASS', 'REST_DENS', 'GAS_CONST', 'VISC', 'STEPS'];
        for (const key of allowed) {
            if (!(key in partial)) continue;
            const value = Number(partial[key]);
            if (!Number.isFinite(value)) continue;
            this.simulationParams[key] = key === 'STEPS' ? Math.max(0, Math.round(value)) : value;
        }
        this.#updateSimulationParams();
    }

    setPointerSettings(partial = {}) {
        Object.assign(this.pointerParams, partial);
        this.pointerParamsNeedUpdate = true;
    }

    setAppearanceSettings(partial = {}) {
        Object.assign(this.appearance, partial);
        if ('backgroundColor' in partial) this.#updateBackgroundRgb();
        if ('environmentPreset' in partial) this.setEnvironmentPreset(partial.environmentPreset);
    }

    setEnvironmentPreset(preset) {
        const valid = ['custom', 'black-studio', 'dark-metallic', 'soft-white', 'colored'];
        const name = valid.includes(preset) ? preset : 'custom';
        this.appearance.environmentPreset = name;
        const metallicEnv = name === 'dark-metallic' || name === 'colored';
        if (this.environmentTextures) {
            this.envMapTexture = metallicEnv ? this.environmentTextures.metallic : this.environmentTextures.studio;
            if (this.groundUniforms) this.groundUniforms.u_envMapTexture = this.envMapTexture;
            if (this.spikesUniforms) this.spikesUniforms.u_envMapTexture = this.envMapTexture;
        }
    }

    setBaseZoom(value) {
        this.baseZoom = Math.max(0.05, Math.min(0.95, Number(value)));
        this.#finishEntryAnimationForLiveControl();
        this.ZOOM = this.baseZoom;
    }

    #finishEntryAnimationForLiveControl() {
        if (this.isEntryAnimationDone) return;
        this.entryProgress = this.entryDuration + this.entryDelay;
        this.isEntryAnimationDone = true;
        this.ZOOM = this.baseZoom;
        this.lastActivityTime = this.#time;
        if (this.onEntryAnimationDone) {
            const callback = this.onEntryAnimationDone;
            this.onEntryAnimationDone = null;
            callback();
        }
    }

    setCameraSettings(partial = {}) {
        if ('autoRotate' in partial) this.cameraControls.autoRotate = Boolean(partial.autoRotate);
        if ('movementPreset' in partial && ['static', 'orbit', 'slow-orbit', 'pendulum', 'figure-eight', 'push-pull', 'audio-pulse'].includes(partial.movementPreset)) {
            this.cameraControls.movementPreset = partial.movementPreset;
            this.cameraMotionPhase = 0;
        }
        if ('smoothing' in partial && Number.isFinite(Number(partial.smoothing))) this.cameraControls.smoothing = Math.max(0, Math.min(1, Number(partial.smoothing)));
        if ('yaw' in partial && Number.isFinite(Number(partial.yaw))) this.cameraTarget.yaw = Number(partial.yaw);
        if ('elevation' in partial && Number.isFinite(Number(partial.elevation))) this.cameraTarget.elevation = Number(partial.elevation);
        if ('distance' in partial && Number.isFinite(Number(partial.distance))) this.cameraTarget.distance = Number(partial.distance);
        if ('rotateSpeed' in partial && Number.isFinite(Number(partial.rotateSpeed))) this.cameraControls.rotateSpeed = Number(partial.rotateSpeed);
        this.cameraTarget.elevation = Math.max(8, Math.min(72, this.cameraTarget.elevation));
        this.cameraTarget.distance = Math.max(0.72, Math.min(2.4, this.cameraTarget.distance));
        if (this.cameraControls.smoothing <= 0.001) {
            this.cameraControls.yaw = this.cameraTarget.yaw;
            this.cameraControls.elevation = this.cameraTarget.elevation;
            this.cameraControls.distance = this.cameraTarget.distance;
            this.#syncCameraFromControls(true);
        }
    }

    #updateCameraMotion(deltaTime) {
        const dt = Math.max(0, deltaTime) / 1000;
        const speed = Number.isFinite(Number(this.cameraControls.rotateSpeed)) ? Number(this.cameraControls.rotateSpeed) : 6;
        if (this.cameraControls.autoRotate) this.cameraTarget.yaw += speed * dt;
        this.cameraTarget.yaw = ((this.cameraTarget.yaw + 180) % 360 + 360) % 360 - 180;

        const preset = this.cameraControls.movementPreset || 'static';
        this.cameraMotionPhase += dt * Math.max(0.15, Math.abs(speed) * Math.PI / 180);
        let desiredYaw = this.cameraTarget.yaw;
        let desiredElevation = this.cameraTarget.elevation;
        let desiredDistance = this.cameraTarget.distance;
        const phase = this.cameraMotionPhase;
        const direction = speed < 0 ? -1 : 1;

        if (preset === 'orbit') desiredYaw += direction * phase * 42;
        else if (preset === 'slow-orbit') desiredYaw += direction * phase * 16;
        else if (preset === 'pendulum') desiredYaw += Math.sin(phase * 1.25) * 30;
        else if (preset === 'figure-eight') {
            desiredYaw += Math.sin(phase) * 32;
            desiredElevation += Math.sin(phase * 2) * 8;
        } else if (preset === 'push-pull') {
            desiredDistance *= 1 + Math.sin(phase * 1.4) * 0.13;
        } else if (preset === 'audio-pulse') {
            desiredDistance = Math.max(0.72, desiredDistance - (this.audioLevels.overall || 0) * 0.22);
            desiredYaw += (this.audioLevels.mids || 0) * 8;
        }

        desiredElevation = Math.max(8, Math.min(72, desiredElevation));
        desiredDistance = Math.max(0.72, Math.min(2.4, desiredDistance));
        const smoothing = Math.max(0, Math.min(1, Number(this.cameraControls.smoothing) || 0));
        const alpha = smoothing <= 0.001 ? 1 : 1 - Math.exp(-deltaTime / (18 + smoothing * 420));
        const angleDelta = ((desiredYaw - this.cameraControls.yaw + 540) % 360) - 180;
        const prevElevation = this.cameraControls.elevation;
        const prevDistance = this.cameraControls.distance;
        this.cameraControls.yaw += angleDelta * alpha;
        this.cameraControls.elevation += (desiredElevation - this.cameraControls.elevation) * alpha;
        this.cameraControls.distance += (desiredDistance - this.cameraControls.distance) * alpha;
        this.cameraControls.yaw = ((this.cameraControls.yaw + 180) % 360 + 360) % 360 - 180;
        const projectionDirty = Math.abs(this.cameraControls.elevation - prevElevation) > 0.0005 || Math.abs(this.cameraControls.distance - prevDistance) > 0.0005;
        this.#syncCameraFromControls(projectionDirty);
    }

    resetCamera() {
        Object.assign(this.cameraControls, {
            yaw: 0,
            elevation: 26.565,
            distance: 1.118034,
            autoRotate: false,
            movementPreset: 'static',
        });
        Object.assign(this.cameraTarget, { yaw: 0, elevation: 26.565, distance: 1.118034 });
        this.cameraMotionPhase = 0;
        this.#syncCameraFromControls();
    }

    setDrawingBufferSize(width, height) {
        const gl = this.gl;
        this.drawingBufferOverride = true;
        this.canvas.width = Math.max(1, Math.round(width));
        this.canvas.height = Math.max(1, Math.round(height));
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.#updateProjectionMatrixForAspect(this.canvas.width / this.canvas.height);
    }

    restoreDisplayResolution() {
        this.drawingBufferOverride = false;
        this.resize();
        this.#updateProjectionMatrix(this.gl);
    }

    setPerformanceSettings(partial = {}) {
        if ('mode' in partial && ['auto', 'manual'].includes(partial.mode)) this.performanceSettings.mode = partial.mode;
        if ('simulationQuality' in partial && this.qualityProfiles[partial.simulationQuality]) this.performanceSettings.simulationQuality = partial.simulationQuality;
        if ('renderScale' in partial) this.performanceSettings.renderScale = Math.max(0.5, Math.min(1, Number(partial.renderScale) || 1));
        if ('adaptiveSimulation' in partial) this.performanceSettings.adaptiveSimulation = Boolean(partial.adaptiveSimulation);
        if ('fpsLimit' in partial) {
            const fps = Number(partial.fpsLimit);
            this.performanceSettings.fpsLimit = [0, 30, 60, 120].includes(fps) ? fps : 60;
        }
        if ('showStats' in partial) this.performanceSettings.showStats = Boolean(partial.showStats);

        const ceiling = Math.max(0, this.qualityOrder.indexOf(this.performanceSettings.simulationQuality));
        const qualityWasExplicitlySet = Object.prototype.hasOwnProperty.call(partial, 'simulationQuality');
        const modeWasExplicitlySet = Object.prototype.hasOwnProperty.call(partial, 'mode');
        const scaleWasExplicitlySet = Object.prototype.hasOwnProperty.call(partial, 'renderScale');

        if (this.performanceSettings.mode === 'manual') {
            this.autoQualityIndex = ceiling;
            this.autoRenderScale = this.performanceSettings.renderScale;
            this.#applyEffectivePerformanceState(this.performanceSettings.simulationQuality, this.performanceSettings.renderScale);
        } else {
            // In Auto mode the Simulation Quality selector is the quality ceiling,
            // but selecting a preset must still apply that preset immediately.
            // Previously a prior Auto downshift could leave the effective quality
            // stuck below the newly selected dropdown value, making the control
            // appear broken. Auto tuning may reduce it again later only if needed.
            if (qualityWasExplicitlySet || modeWasExplicitlySet) {
                this.autoQualityIndex = ceiling;
                this.lastAutoTuneTime = performance.now();
            } else {
                this.autoQualityIndex = Math.min(this.autoQualityIndex, ceiling);
            }
            if (scaleWasExplicitlySet || modeWasExplicitlySet) {
                this.autoRenderScale = this.performanceSettings.renderScale;
            } else {
                this.autoRenderScale = Math.min(this.autoRenderScale, this.performanceSettings.renderScale);
            }
            this.#applyEffectivePerformanceState(this.qualityOrder[this.autoQualityIndex], Math.min(this.performanceSettings.renderScale, this.autoRenderScale));
        }
        this.performanceStats.showStats = this.performanceSettings.showStats;
    }

    setExportMode(enabled) {
        this.performanceSettings.exportMode = Boolean(enabled);
        if (enabled) {
            // Export dimensions are explicit, so preview render scale is bypassed.
            this.#applyEffectivePerformanceState(this.performanceSettings.simulationQuality, 1);
        } else {
            this.setPerformanceSettings({});
        }
    }

    getPerformanceStats() {
        this.performanceStats.showStats = this.performanceSettings.showStats;
        return this.performanceStats;
    }

    getSerializableState() {
        return {
            audioReactive: { ...this.audioReactive },
            simulation: {
                MASS: this.simulationParams.MASS,
                REST_DENS: this.simulationParams.REST_DENS,
                GAS_CONST: this.simulationParams.GAS_CONST,
                VISC: this.simulationParams.VISC,
                STEPS: this.simulationParams.STEPS,
            },
            pointer: { ...this.pointerParams },
            camera: { ...this.cameraControls, targetYaw: this.cameraTarget.yaw, targetElevation: this.cameraTarget.elevation, targetDistance: this.cameraTarget.distance },
            appearance: { ...this.appearance },
            baseZoom: this.baseZoom,
            performance: {
                mode: this.performanceSettings.mode,
                simulationQuality: this.performanceSettings.simulationQuality,
                renderScale: this.performanceSettings.renderScale,
                adaptiveSimulation: this.performanceSettings.adaptiveSimulation,
                fpsLimit: this.performanceSettings.fpsLimit,
                showStats: this.performanceSettings.showStats,
            },
        };
    }

    setManualFrameMode(enabled) {
        this.manualFrameMode = Boolean(enabled);
        this.lastProcessedFrameTime = 0;
        this.#time = performance.now();
    }

    renderDeterministicFrame(deltaMs, analysisFrame = null) {
        if (this.contextLost || !this.envMapTextureLoaded) return;
        const dt = Math.max(1, Number(deltaMs) || this.TARGET_FRAME_DURATION);
        this.#deltaTime = dt;
        this.#deltaFrames = dt / this.TARGET_FRAME_DURATION;
        this.#frames += this.#deltaFrames;
        this.externalAnalysisFrame = analysisFrame;
        this.#animate(dt);
        this.#render();
        this.externalAnalysisFrame = null;
    }

    getGpuCapabilities() {
        const gl = this.gl;
        if (!gl) return { renderer: 'Unavailable', vendor: 'Unavailable', recommendedQuality: 'medium', tier: 'Unknown' };
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
        const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
        const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
        const text = `${vendor} ${renderer}`.toLowerCase();
        const integrated = /intel|iris|uhd|adreno|mali|apple gpu|powervr/.test(text);
        let recommendedQuality = 'ultra';
        let tier = 'High';
        if (mobile || maxTextureSize < 8192) { recommendedQuality = 'medium'; tier = 'Moderate'; }
        else if (integrated || maxRenderbufferSize < 8192) { recommendedQuality = 'high'; tier = 'Balanced'; }
        return { renderer: String(renderer || 'Unknown'), vendor: String(vendor || 'Unknown'), maxTextureSize, maxRenderbufferSize, recommendedQuality, tier };
    }

    applySerializableState(state = {}) {
        if (state.audioReactive) this.setAudioReactiveSettings(state.audioReactive);
        if (state.simulation) this.setSimulationSettings(state.simulation);
        if (state.pointer) this.setPointerSettings(state.pointer);
        if (state.appearance) this.setAppearanceSettings(state.appearance);
        if (state.baseZoom != null) this.setBaseZoom(state.baseZoom);
        if (state.camera) {
            const camera = state.camera;
            if (camera.targetYaw != null) this.cameraTarget.yaw = camera.targetYaw;
            if (camera.targetElevation != null) this.cameraTarget.elevation = camera.targetElevation;
            if (camera.targetDistance != null) this.cameraTarget.distance = camera.targetDistance;
            this.setCameraSettings(camera);
        }
        if (state.performance) this.setPerformanceSettings(state.performance);
    }

    #getReactiveLevel() {
        if (!this.audioReactive.enabled) return 0;
        const base = this.audioLevels[this.audioReactive.band] ?? this.audioLevels.overall ?? 0;
        const transient = (this.audioLevels.transient || 0) * (this.audioReactive.transientImpact || 0);
        return Math.max(0, Math.min(1.75, base + transient));
    }

    #syncCameraFromControls(updateProjection = true) {
        const yaw = this.cameraControls.yaw * Math.PI / 180;
        const elevation = this.cameraControls.elevation * Math.PI / 180;
        const distance = this.cameraControls.distance;
        const horizontal = Math.cos(elevation) * distance;
        vec3.set(
            this.camera.position,
            Math.sin(yaw) * horizontal,
            Math.sin(elevation) * distance,
            Math.cos(yaw) * horizontal
        );
        this.#updateCameraMatrix();
        if (updateProjection && this.gl) this.#updateProjectionMatrix(this.gl);
    }


    #updateCameraMatrix() {
        mat4.targetTo(this.camera.matrix, this.camera.position, [0, 0, 0], this.camera.up);
        mat4.invert(this.camera.matrices.view, this.camera.matrix);
        // Keep the complete camera transform coherent whenever yaw changes.
        // Auto Rotate updates yaw every frame; previously the inverse
        // view-projection remained stale until a resize/projection change.
        if (this.camera.matrices.inversProjection) {
            mat4.multiply(
                this.camera.matrices.inversViewProjection,
                this.camera.matrix,
                this.camera.matrices.inversProjection
            );
        }
    }

    #updateProjectionMatrix(gl) {
        const width = gl.canvas.clientWidth || gl.drawingBufferWidth || 1;
        const height = gl.canvas.clientHeight || gl.drawingBufferHeight || 1;
        this.#updateProjectionMatrixForAspect(width / height);
    }

    #updateProjectionMatrixForAspect(aspect) {
        this.camera.aspect = aspect || 1;

        const framingHeight = .4;
        const cameraDistance = this.cameraControls?.distance || vec3.length(this.camera.position);
        const elevation = (this.cameraControls?.elevation ?? 0) * Math.PI / 180;
        const framingDistance = Math.max(0.001, cameraDistance * Math.cos(elevation));
        if (this.camera.aspect > 1) {
            this.camera.fov = 2 * Math.atan(framingHeight / framingDistance);
        } else {
            this.camera.fov = 2 * Math.atan((framingHeight / this.camera.aspect) / framingDistance);
        }

        mat4.perspective(this.camera.matrices.projection, this.camera.fov, this.camera.aspect, this.camera.near, this.camera.far);
        mat4.invert(this.camera.matrices.inversProjection, this.camera.matrices.projection);
        mat4.multiply(this.camera.matrices.inversViewProjection, this.camera.matrix, this.camera.matrices.inversProjection);
    }

    #getPointerSpikesPlaneIntersection() {
        const p = this.#screenToWorldPosition(this.pointer[0], this.pointer[1], 0);
        vec3.set(
            this.pointerRay,
            p[0] - this.camera.position[0],
            p[1] - this.camera.position[1],
            p[2] - this.camera.position[2]
        );
        const denominator = Math.abs(this.pointerRay[1]) < 0.000001 ? 0.000001 : this.pointerRay[1];
        const t = -this.camera.position[1] / denominator;
        vec3.scale(this.pointerRay, this.pointerRay, t);
        vec3.add(this.pointerIntersection, this.camera.position, this.pointerRay);
        const scale = 1 / (this.ZOOM + this.#remapHeightMapZoomScale(this.ZOOM));
        vec2.set(this.pointer, this.pointerIntersection[0] * scale, this.pointerIntersection[2] * scale);
        return this.pointer;
    }

    #screenToWorldPosition(x, y, z) {
        vec4.set(this.screenNdc, x, y, z, 1);
        vec4.transformMat4(this.screenWorld, this.screenNdc, this.camera.matrices.inversViewProjection);
        if (this.screenWorld[3] !== 0) vec4.scale(this.screenWorld, this.screenWorld, 1 / this.screenWorld[3]);
        return this.screenWorld;
    }

    #remapZoomForHeight(zoom) {
        // https://www.desmos.com/calculator/lac2i0bgum
        return -0.36 * zoom * zoom + -0.02 * zoom + 0.38;
    }

    #remapHeightMapZoomScale(zoom) {
        return 2 * zoom * zoom + zoom + 1;
    }

    #remapSmoothFactorZoom(zoom) {
        return .3 * zoom * zoom + -0.07 * zoom + 0.02;
    }

    #remapSpikeFactorZoom(zoom) {
        return 12 * zoom * zoom + -36 * zoom + 25;
    }
}
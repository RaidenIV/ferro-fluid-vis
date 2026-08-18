export default `#version 300 es

precision highp float;
precision highp int;

uniform float u_heightFactor;
uniform float u_scale;
uniform float u_smoothFactor;
uniform float u_spikeFactor;
uniform sampler2D u_particlePosTexture;
uniform float u_audioBass;
uniform float u_audioMids;
uniform float u_audioTreble;
uniform float u_regionMapping;
uniform float u_regionStrength;

in vec2 v_uv;
out vec4 outHeight;

ivec2 ndx2tex(ivec2 dimensions, int index) {
    return ivec2(index % dimensions.x, index / dimensions.x);
}

float almostIdentity(float x, float m, float n) {
    if (x > m) return x;
    float a = 2.0 * n - m;
    float b = 2.0 * m - 3.0 * n;
    float t = x / m;
    return (a * t + b) * t * t + n;
}

void main() {
    ivec2 particleTexSize = textureSize(u_particlePosTexture, 0);
    int particleCount = particleTexSize.x * particleTexSize.y;
    vec2 pos = v_uv * 2.0 - 1.0;
    float w = u_smoothFactor;
    float res = 1.0;

    for (int i = 0; i < particleCount; i++) {
        vec2 pj = texelFetch(u_particlePosTexture, ndx2tex(particleTexSize, i), 0).xy * u_scale;
        vec2 delta = pj - pos;
        float d = sqrt(dot(delta, delta));
        float h = smoothstep(-1.0, 1.0, (res - d) / w);
        res = mix(res, d, h) - h * (1.0 - h) * (w / (1.0 + 3.0 * w));
    }

    res = clamp(res * u_spikeFactor, 0.0, 1.0);
    res = almostIdentity(res, 0.1, 0.04);
    res = (1.0 - res) * u_heightFactor;

    if (u_regionMapping > 0.5) {
        float radius = length(pos);
        float bassWeight = 1.0 - smoothstep(0.18, 0.62, radius);
        float midsWeight = smoothstep(0.18, 0.46, radius) * (1.0 - smoothstep(0.56, 0.82, radius));
        float trebleWeight = smoothstep(0.48, 0.92, radius);
        float regionDrive = u_audioBass * bassWeight + u_audioMids * midsWeight + u_audioTreble * trebleWeight;
        res *= 1.0 + regionDrive * u_regionStrength;
    }

    outHeight = vec4(res);
}`;

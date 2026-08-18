export default `#version 300 es
precision highp float;

uniform sampler2D u_sceneTexture;
uniform vec2 u_texelSize;
uniform float u_bloomStrength;
uniform float u_bloomThreshold;
uniform float u_bloomRadius;

in vec2 v_uv;
out vec4 outColor;

vec3 brightSample(vec2 uv) {
    vec3 c = texture(u_sceneTexture, uv).rgb;
    float lum = max(c.r, max(c.g, c.b));
    float knee = max(0.001, 1.0 - u_bloomThreshold);
    float w = clamp((lum - u_bloomThreshold) / knee, 0.0, 1.0);
    return c * w;
}

void main() {
    vec3 base = texture(u_sceneTexture, v_uv).rgb;
    vec2 d = u_texelSize * max(0.5, u_bloomRadius);
    vec3 bloom = brightSample(v_uv) * 0.18;
    bloom += brightSample(v_uv + vec2( d.x, 0.0)) * 0.11;
    bloom += brightSample(v_uv + vec2(-d.x, 0.0)) * 0.11;
    bloom += brightSample(v_uv + vec2(0.0,  d.y)) * 0.11;
    bloom += brightSample(v_uv + vec2(0.0, -d.y)) * 0.11;
    bloom += brightSample(v_uv + vec2( d.x,  d.y)) * 0.075;
    bloom += brightSample(v_uv + vec2(-d.x,  d.y)) * 0.075;
    bloom += brightSample(v_uv + vec2( d.x, -d.y)) * 0.075;
    bloom += brightSample(v_uv + vec2(-d.x, -d.y)) * 0.075;
    vec2 d2 = d * 2.2;
    bloom += brightSample(v_uv + vec2( d2.x, 0.0)) * 0.035;
    bloom += brightSample(v_uv + vec2(-d2.x, 0.0)) * 0.035;
    bloom += brightSample(v_uv + vec2(0.0,  d2.y)) * 0.035;
    bloom += brightSample(v_uv + vec2(0.0, -d2.y)) * 0.035;
    outColor = vec4(base + bloom * u_bloomStrength, 1.0);
}`;

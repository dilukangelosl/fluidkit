// GLSL ES 3.00 sources for the Stable Fluids pass graph (Jos Stam, 1999):
// splat inputs → curl → vorticity → divergence → pressure×N → gradient subtract → advect.
// Kept readable and commented on purpose — these double as the reference implementation.

export const baseVertex = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;

void main () {
    vUv = aPosition * 0.5 + 0.5;
    // Precomputed neighbour coords for the finite-difference passes.
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`

// Adds a gaussian blob of `color` into the target field (used for both velocity and dye).
export const splatFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;

void main () {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`

// Semi-Lagrangian advection: walk backwards along the velocity field and sample.
// `drift` (x = wind, y = gravity) adds a constant dye drift — a body force alone gets
// mostly cancelled by the pressure projection inside large dye masses.
export const advectionFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
uniform vec2 drift;

void main () {
    vec2 velocity = texture(uVelocity, vUv).xy;
    velocity.x += drift.x;
    velocity.y -= drift.y * smoothstep(0.0, 0.05, vUv.y); // fade at the floor so liquid pools, not drains
    vec2 coord = vUv - dt * velocity * texelSize;
    fragColor = texture(uSource, coord) / (1.0 + dissipation * dt);
}`

// Pulls dye-carrying fluid downward. Weighted by dye density so empty regions stay still.
export const gravityFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform float gravity;
uniform float dt;

void main () {
    vec2 velocity = texture(uVelocity, vUv).xy;
    float mass = clamp(dot(texture(uDye, vUv).rgb, vec3(1.0)), 0.0, 1.0);
    velocity.y -= gravity * mass * dt;
    fragColor = vec4(velocity, 0.0, 1.0);
}`

export const curlFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float T = texture(uVelocity, vT).x;
    float B = texture(uVelocity, vB).x;
    fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`

// Vorticity confinement: push velocity towards local curl maxima to fight numerical damping.
export const vorticityFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;

void main () {
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float T = texture(uCurl, vT).x;
    float B = texture(uCurl, vB).x;
    float C = texture(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;

    vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
    fragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}`

export const divergenceFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uVelocity, vL).x;
    float R = texture(uVelocity, vR).x;
    float T = texture(uVelocity, vT).y;
    float B = texture(uVelocity, vB).y;

    // Free-slip boundary: reflect velocity at the walls.
    vec2 C = texture(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }

    fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

// Multiplies the previous pressure by a decay factor before the Jacobi solve warm-starts from it.
export const clearFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform float value;

void main () {
    fragColor = value * texture(uTexture, vUv);
}`

// One Jacobi iteration of the pressure Poisson equation.
export const pressureFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    float divergence = texture(uDivergence, vUv).x;
    fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`

// Subtract the pressure gradient to make the velocity field divergence-free.
export const gradientSubtractFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float T = texture(uPressure, vT).x;
    float B = texture(uPressure, vB).x;
    vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
    fragColor = vec4(velocity, 0.0, 1.0);
}`

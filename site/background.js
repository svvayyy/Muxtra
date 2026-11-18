/* muxtra.dev background. Gradient engine (c) gradients.sh, MIT. Simplex noise (c) Ian McEwan, Stefan Gustavson, Ashima Arts, MIT. Source: third_party/gradients-sh */
var Ar=Object.defineProperty;var P=(e,t,r)=>()=>{if(r)throw r[0];try{return e&&(t=e(e=0)),t}catch(o){throw r=[o],o}};var pe=(e,t)=>{for(var r in t)Ar(e,r,{get:t[r],enumerable:!0})};function te(e,t){return e[t%e.length]??"transparent"}var Te=P(()=>{});var kt={};pe(kt,{wgsl:()=>Ir});var Ir,Pt=P(()=>{Ir=`
fn kindColor(p: vec2f, uv: vec2f) -> vec3f {
  let h = frameHalf();
  let theta = seedAngle();
  let axis = vec2f(cos(theta), sin(theta));
  let side = vec2f(-axis.y, axis.x);
  let span = abs(axis.x) * h.x + abs(axis.y) * h.y;
  let q = p + u.warp * 0.14 * vec2f(
    flowNoise(p * 1.2 * u.scale, 1.0),
    flowNoise(p * 1.2 * u.scale + 4.1, 2.0)
  );
  let sigma = (0.22 + 0.2 * u.blur) / u.scale;
  let inv = 1.0 / (sigma * sigma);
  let count = f32(u.count);
  let wb = 0.06;
  var lab = u.bg * wb;
  var chroma = length(u.bg.yz) * wb;
  var total = wb;
  for (var i = 0; i < 6; i++) {
    if (i >= u.count) { break; }
    let fi = f32(i);
    let k = fi / max(1.0, count - 1.0);
    let zig = (gmod1(fi, 2.0) * 2.0 - 1.0) * (0.25 + 0.5 * fract(fi * 0.618 + 0.3));
    let c = axis * span * (0.9 - 1.8 * k) + side * span * 0.5 * zig
      + 0.25 * h * (rot2(fi * 1.7) * u.loopv);
    var d = q - c;
    d = vec2f(dot(d, axis) * 1.2, dot(d, side) * 0.65);
    let w = exp(-dot(d, d) * inv);
    lab += u.colors[i].xyz * w;
    chroma += length(u.colors[i].yz) * w;
    total += w;
  }
  lab /= total;
  chroma /= total;
  let current = length(lab.yz);
  if (current > 1e-4) {
    lab = vec3f(lab.x, lab.yz * mix(1.0, chroma / current, 0.85));
  }
  lab.x += 0.05 * dot(p, axis) / span;
  let along = dot(q, side);
  let crest = 0.16 * sin(along * 1.6 + 0.8 * dot(u.loopv, vec2f(0.6, 0.8)) + theta)
    + 0.08 * flowNoise(vec2f(along * 0.6, 2.0), 3.0);
  let acrossFold = dot(q, axis) - crest;
  let fw = 0.05 + 0.08 * u.blur;
  lab.x += 0.06 * exp(-acrossFold * acrossFold / (fw * fw)) - 0.07 * smoothstep(0.0, 0.5, -acrossFold);
  lab.x *= vignette(p, 0.18);
  return filmGrade(lab);
}
`});var Ct,re,Ae=P(()=>{Te();Ct=[[16,20],[84,26],[72,86],[22,80],[52,48],[92,62]],re={defaults:{background:"#0a0d24",blur:.45,colors:["#ecdcf2","#8796ee","#2e45b7","#0e1645"],dither:{cell:3,enabled:!1,levels:8},grain:.1,interaction:{pointer:.2,scroll:.1},loopSeconds:14,scale:1,seed:42,speed:.6,warp:.4},description:"Soft, lit colour fields drifting through each other.",fallbackLayers:e=>e.map((t,r)=>{let[o,n]=Ct[r%Ct.length]??[50,50];return`radial-gradient(85% 95% at ${o}% ${n}%, ${te(e,r)} 0%, transparent 68%)`}),glsl:`
vec3 kindColor(vec2 p, vec2 uv) {
  vec2 h = frameHalf();
  // The palette marches from a lit corner to the far one: colour 0 sits in
  // the light, the last colour in the shadow.
  float theta = seedAngle();
  vec2 axis = vec2(cos(theta), sin(theta));
  vec2 side = vec2(-axis.y, axis.x);
  float span = abs(axis.x) * h.x + abs(axis.y) * h.y;
  vec2 q = p + u_warp * 0.14 * vec2(
    flowNoise(p * 1.2 * u_scale, 1.0),
    flowNoise(p * 1.2 * u_scale + 4.1, 2.0)
  );
  float sigma = (0.22 + 0.2 * u_blur) / u_scale;
  float inv = 1.0 / (sigma * sigma);
  float count = float(u_count);
  float wb = 0.06;
  vec3 lab = u_bg * wb;
  float chroma = length(u_bg.yz) * wb;
  float total = wb;
  for (int i = 0; i < 6; i++) {
    if (i >= u_count) break;
    float fi = float(i);
    float k = fi / max(1.0, count - 1.0);
    float zig = (mod(fi, 2.0) * 2.0 - 1.0) * (0.25 + 0.5 * fract(fi * 0.618 + 0.3));
    vec2 c = axis * span * (0.9 - 1.8 * k) + side * span * 0.5 * zig
      + 0.25 * h * (rot2(fi * 1.7) * u_loop);
    vec2 d = q - c;
    // Fields are wider across the axis than along it: soft bands of light.
    d = vec2(dot(d, axis) * 1.2, dot(d, side) * 0.65);
    float w = exp(-dot(d, d) * inv);
    lab += u_colors[i] * w;
    chroma += length(u_colors[i].yz) * w;
    total += w;
  }
  lab /= total;
  chroma /= total;
  float current = length(lab.yz);
  if (current > 1e-4) {
    lab.yz *= mix(1.0, chroma / current, 0.85);
  }
  lab.x += 0.05 * dot(p, axis) / span;
  // One long silk fold across the frame: a lit crest, then the cloth turns
  // into shadow behind it.
  float along = dot(q, side);
  float crest = 0.16 * sin(along * 1.6 + 0.8 * dot(u_loop, vec2(0.6, 0.8)) + theta)
    + 0.08 * flowNoise(vec2(along * 0.6, 2.0), 3.0);
  float acrossFold = dot(q, axis) - crest;
  float fw = 0.05 + 0.08 * u_blur;
  lab.x += 0.06 * exp(-acrossFold * acrossFold / (fw * fw)) - 0.07 * smoothstep(0.0, 0.5, -acrossFold);
  lab.x *= vignette(p, 0.18);
  return filmGrade(lab);
}
`,label:"Mesh",name:"mesh",wgsl:()=>Promise.resolve().then(()=>(Pt(),kt)).then(e=>e.wgsl)}});function Ie(e){if(typeof e!="object"||e===null||Array.isArray(e))throw new TypeError("Expected an object");return Object.fromEntries(Object.entries(e))}function M(e,t){if(typeof e!="number"||!Number.isFinite(e))throw new TypeError(`${t} must be a number`);return e}function Br(e,t){let r=M(e,t);if(!Number.isInteger(r))throw new TypeError(`${t} must be an integer`);return r}function Be(e,t){if(typeof e!="string")throw new TypeError(`${t} must be a string`);return e}function Wr(e){let t=Ie(e),r=t.colors;if(!Array.isArray(r)||r.length<2||r.length>6)throw new TypeError("colors must contain 2 to 6 entries");let o=Ie(t.dither),n=Ie(t.interaction),i={background:Be(t.background,"background"),blur:M(t.blur,"blur"),colors:r.map(s=>Be(s,"colors")),dither:{cell:M(o.cell,"dither.cell"),enabled:Fr(o.enabled,"dither.enabled"),levels:M(o.levels,"dither.levels")},grain:M(t.grain,"grain"),interaction:{pointer:M(n.pointer,"interaction.pointer"),scroll:M(n.scroll,"interaction.scroll")},kind:Be(t.kind,"kind"),loopSeconds:M(t.loopSeconds,"loopSeconds"),scale:M(t.scale,"scale"),seed:Br(t.seed,"seed"),speed:M(t.speed,"speed"),warp:M(t.warp,"warp")};return t.drift===void 0?i:{...i,drift:M(t.drift,"drift")}}function Fr(e,t){if(typeof e!="boolean")throw new TypeError(`${t} must be a boolean`);return e}function z(e){let t=Wr(e),r={...t,blur:G(t.blur,0,1),colors:t.colors.slice(0,6),dither:{cell:Math.round(G(t.dither.cell,1,32)),enabled:t.dither.enabled,levels:Math.round(G(t.dither.levels,2,32))},grain:G(t.grain,0,1),interaction:{pointer:G(t.interaction.pointer,0,1),scroll:G(t.interaction.scroll,0,1)},loopSeconds:G(t.loopSeconds,4,30),scale:G(t.scale,.25,4),speed:G(t.speed,0,2),warp:G(t.warp,0,1)};return t.drift!==void 0&&(r.drift=G(t.drift,0,2)),r}function ne(e,t){return z({...e,...t,dither:{...e.dither,...t.dither},interaction:{...e.interaction,...t.interaction}})}var We,G,U=P(()=>{Ae();We={...re.defaults,kind:"mesh"},G=(e,t,r)=>Math.min(r,Math.max(t,e))});var St={};pe(St,{wgsl:()=>Or});var Or,Et=P(()=>{Or=`
fn kindColor(p: vec2f, uv: vec2f) -> vec3f {
  let lightBg = smoothstep(0.55, 0.85, u.bg.x);
  let h = frameHalf();
  let framing = fract(u.seed.x * 0.0731 + 0.5);
  var radius = 0.34;
  var centre = vec2f(0.0, -0.3);
  var spread = 0.28;
  if (framing > 0.7) {
    radius = 0.75;
    centre = vec2f(0.35 * h.x * sign(u.seed.y), -0.95);
    spread = 0.1;
  } else if (framing > 0.4) {
    radius = 0.26;
    centre = vec2f(0.0, -0.04);
    spread = 0.6;
  }
  radius /= u.scale;
  centre.y -= 0.04 * flowNoise(vec2f(0.3, 0.7), 1.0);
  let d = p - centre;
  let r = length(d);
  let dir = d / max(r, 1e-4);
  let x = r - radius;
  let xo = max(x, 0.0);
  let soft = (0.01 + 0.045 * u.blur) * (1.0 + 5.0 * lightBg);

  let sweep = 1.3 * u.loopv.x;
  let up = vec2f(sin(sweep), cos(sweep));
  let facing = 0.5 + 0.5 * dot(dir, up) * smoothstep(0.0, radius, r);
  let key = mix(spread, 1.0, facing * facing);

  var rays = 0.5 + 0.5 * flowNoise(dir * 2.6 - vec2f(0.0, r * 0.35), 2.0);
  rays = mix(rays, 0.5 + 0.5 * flowNoise(dir * 6.0 - vec2f(r * 0.5, 0.0), 3.0), 0.35);
  rays = mix(1.0, 0.25 + 1.3 * rays * rays, u.warp);

  let rim = exp(-xo / soft);
  let corona = exp(-xo / (0.05 + 0.1 * u.blur));
  let haze = exp(-xo / (0.3 + 0.3 * u.blur));
  let ringD = (x - 0.05 - 0.04 * u.blur) / ((0.018 + 0.03 * u.blur) * (1.0 + 2.0 * lightBg));
  let ring = exp(-ringD * ringD);
  var glow = (rim + 0.5 * corona * (0.6 + 0.4 * rays) + (0.4 + 0.35 * lightBg) * haze * mix(1.0, rays, 0.8) + 0.35 * ring) * key;

  let inside = 1.0 - smoothstep(-soft * 0.5, soft * 0.5, x);
  let innerRim = exp(min(x, 0.0) / (0.01 + 0.12 * lightBg));
  glow = mix(glow, (0.3 * innerRim + 0.06) * key, inside * (1.0 - 0.85 * lightBg));

  let reach = clamp(xo / (0.6 + 0.3 * u.blur), 0.0, 1.0);
  let t = mix(sqrt(reach), smoothstep(0.0, 0.7, reach), lightBg);
  var col = ramp(t);
  let hot = vec3f(min(1.0, paletteColor(0).x + 0.06), paletteColor(0).yz * 0.4);
  col = labMix(col, hot, rim * (1.0 - inside) * (0.45 + 0.5 * lightBg));
  col = labMix(col, paletteColor(2), ring * (0.6 - 0.35 * lightBg) * (1.0 - rim));

  var base = u.bg;
  base.x *= mix(1.0, mix(0.35, 1.0, lightBg), inside);
  var lab = labMix(base, col, clamp(glow, 0.0, 1.0));
  lab.x += 0.1 * max(glow - 0.9, 0.0);
  lab.x *= vignette(p, 0.3 * (1.0 - lightBg));
  return filmGrade(lab);
}
`});function Dr(e){let t=Math.max(1,e.length-1);return e.map((r,o)=>`color-mix(in oklab, ${r} ${Math.round(45-30*o/t)}%, transparent) ${(29+40*o/t).toFixed(1)}%`).join(", ")}var Rt,Mt=P(()=>{Te();Rt={defaults:{background:"#020204",blur:.45,colors:["#f3f1ff","#9db4ff","#5a46cb","#1d1240"],dither:{cell:3,enabled:!1,levels:8},grain:.14,interaction:{pointer:.2,scroll:.1},loopSeconds:14,scale:1,seed:11,speed:.6,warp:.5},description:"An eclipse: light spilling round a dark disc, with a corona and god rays.",fallbackLayers:e=>[`radial-gradient(42% 58% at 50% 82%, transparent 54%, color-mix(in oklab, ${te(e,0)} 80%, transparent) 58%, color-mix(in oklab, ${te(e,1)} 45%, transparent) 64%, transparent 82%)`,`radial-gradient(84% 116% at 50% 82%, transparent 27%, ${Dr(e)}, transparent 85%)`],glsl:`
vec3 kindColor(vec2 p, vec2 uv) {
  // Light-mode backgrounds get a glowing halo instead of a dark disc.
  float lightBg = smoothstep(0.55, 0.85, u_bg.x);
  // The seed picks a layout: a disc rising from the bottom edge, a full ring
  // in the frame, or the rim of a planet low and off to one side.
  vec2 h = frameHalf();
  float framing = fract(u_seed.x * 0.0731 + 0.5);
  float radius = 0.34;
  vec2 centre = vec2(0.0, -0.3);
  float spread = 0.28;
  if (framing > 0.7) {
    radius = 0.75;
    centre = vec2(0.35 * h.x * sign(u_seed.y), -0.95);
    spread = 0.1;
  } else if (framing > 0.4) {
    radius = 0.26;
    centre = vec2(0.0, -0.04);
    spread = 0.6;
  }
  radius /= u_scale;
  centre.y -= 0.04 * flowNoise(vec2(0.3, 0.7), 1.0);
  vec2 d = p - centre;
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float x = r - radius;
  float xo = max(x, 0.0);
  float soft = (0.01 + 0.045 * u_blur) * (1.0 + 5.0 * lightBg);

  // The source sits behind the disc, so the top of the rim is lit hardest.
  // The source drifts round behind the disc, so the hot side wanders.
  float sweep = 1.3 * u_loop.x;
  vec2 up = vec2(sin(sweep), cos(sweep));
  float facing = 0.5 + 0.5 * dot(dir, up) * smoothstep(0.0, radius, r);
  float key = mix(spread, 1.0, facing * facing);

  // God rays: noise sampled on the unit circle, so they radiate with no seam,
  // fine in angle and drifting slowly outward in radius.
  float rays = 0.5 + 0.5 * flowNoise(dir * 2.6 - vec2(0.0, r * 0.35), 2.0);
  rays = mix(rays, 0.5 + 0.5 * flowNoise(dir * 6.0 - vec2(r * 0.5, 0.0), 3.0), 0.35);
  rays = mix(1.0, 0.25 + 1.3 * rays * rays, u_warp);

  float rim = exp(-xo / soft);
  float corona = exp(-xo / (0.05 + 0.1 * u_blur));
  float haze = exp(-xo / (0.3 + 0.3 * u_blur));
  // A thin halo ring just outside the rim, in the palette's middle colour.
  float ringD = (x - 0.05 - 0.04 * u_blur) / ((0.018 + 0.03 * u_blur) * (1.0 + 2.0 * lightBg));
  float ring = exp(-ringD * ringD);
  float glow = (rim + 0.5 * corona * (0.6 + 0.4 * rays) + (0.4 + 0.35 * lightBg) * haze * mix(1.0, rays, 0.8) + 0.35 * ring) * key;

  // Inside: the occluder, with a hairline of light just inside its edge.
  float inside = 1.0 - smoothstep(-soft * 0.5, soft * 0.5, x);
  float innerRim = exp(min(x, 0.0) / (0.01 + 0.12 * lightBg));
  glow = mix(glow, (0.3 * innerRim + 0.06) * key, inside * (1.0 - 0.85 * lightBg));

  // Palette runs outward from the rim; the hottest light bleaches toward white.
  // A dark disc hides the rim, so colour can rise sharply there; a light
  // glow has no disc edge to hide behind, so it eases in.
  float reach = clamp(xo / (0.6 + 0.3 * u_blur), 0.0, 1.0);
  float t = mix(sqrt(reach), smoothstep(0.0, 0.7, reach), lightBg);
  vec3 col = ramp(t);
  vec3 hot = vec3(min(1.0, paletteColor(0).x + 0.06), paletteColor(0).yz * 0.4);
  col = labMix(col, hot, rim * (1.0 - inside) * (0.45 + 0.5 * lightBg));
  col = labMix(col, paletteColor(2), ring * (0.6 - 0.35 * lightBg) * (1.0 - rim));

  vec3 base = u_bg;
  base.x *= mix(1.0, mix(0.35, 1.0, lightBg), inside);
  vec3 lab = labMix(base, col, clamp(glow, 0.0, 1.0));
  lab.x += 0.1 * max(glow - 0.9, 0.0);
  lab.x *= vignette(p, 0.3 * (1.0 - lightBg));
  return filmGrade(lab);
}
`,wgsl:()=>Promise.resolve().then(()=>(Et(),St)).then(e=>e.wgsl),label:"Radial glow",name:"radial-glow"}});function Gt(e){Lt.set(e.name,e)}function T(e){return Lt.get(e)??re}var Lt,K=P(()=>{Ae();Mt();Lt=new Map;for(let e of[re,Rt])Gt(e)});function Oe(e){return e<=.04045?e/12.92:((e+.055)/1.055)**2.4}function oe(e){let t=Oe(e[0]),r=Oe(e[1]),o=Oe(e[2]),n=Math.cbrt(.4122214708*t+.5363325363*r+.0514459929*o),i=Math.cbrt(.2119034982*t+.6806995451*r+.1073969566*o),s=Math.cbrt(.0883024619*t+.2817188376*r+.6299787005*o);return[.2104542553*n+.793617785*i-.0040720468*s,1.9779984951*n-2.428592205*i+.4505937099*s,.0259040371*n+.7827717662*i-.808675766*s]}function $r(e){let t=Number.parseFloat(e);return Number.isNaN(t)?null:e.endsWith("%")?t/100:t/255}function Yr(e){let t=e.trim(),r=qr.exec(t)?.[1];if(r){let n=r.length<=4?[...r].map(i=>i+i).join(""):r;return n.length!==6&&n.length!==8?null:[Number.parseInt(n.slice(0,2),16)/255,Number.parseInt(n.slice(2,4),16)/255,Number.parseInt(n.slice(4,6),16)/255]}let o=Vr.exec(t)?.[1];if(o){let i=o.split(/[\s,/]+/).filter(Boolean).slice(0,3).map($r),[s,a,d]=i;if(i.length===3&&s!=null&&a!=null&&d!=null)return[s,a,d]}return null}function Kr(){if(j!==void 0)return j;if(j=null,typeof OffscreenCanvas<"u")j=new OffscreenCanvas(1,1).getContext("2d",{willReadFrequently:!0});else if(typeof document<"u"){let e=document.createElement("canvas");e.width=1,e.height=1,j=e.getContext("2d",{willReadFrequently:!0})}return j}function jr(e){let t=Kr();if(!t)return null;let r="#010203";if(t.fillStyle=r,t.fillStyle=e,t.fillStyle===r&&e.trim().toLowerCase()!==r)return null;t.clearRect(0,0,1,1),t.fillRect(0,0,1,1);let[o=0,n=0,i=0]=t.getImageData(0,0,1,1).data;return[o/255,n/255,i/255]}function De(e,t,r=0){let o=Xr.exec(e.trim());if(!o||r>8)return e.trim();let[,n="",i]=o,s=t&&typeof getComputedStyle<"u"?getComputedStyle(t).getPropertyValue(n).trim():"";return s?De(s,t,r+1):i?De(i,t,r+1):""}function ie(e,t){let r=De(e,t),o=me.get(r);if(o)return o;let n=Yr(r)??jr(r)??Nr;return me.size>256&&me.clear(),me.set(r,n),n}function Ue(e){return e.some(t=>t.includes("var("))}var Nr,qr,Vr,j,Xr,me,ge=P(()=>{Nr=[.5,.5,.5];qr=/^#([0-9a-f]{3,8})$/i,Vr=/^rgba?\(\s*([^)]+)\)$/i;Xr=/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/;me=new Map});function xe(e,t){let r=(e%t+t)%t;return 2*Math.PI*r/t}function Ne(e,t,r,o){let n=o===void 0,i=xe(e,t)*(n?1:r),s=n?r*.6:o;return[Math.cos(i)*s,Math.sin(i)*s]}function qe(e,t=.6){return[Math.cos(e)*t,Math.sin(e)*t]}function zt(e,t,r=60){let o=Math.max(1,Math.round(t*r));return(Math.floor(e)%o+o)%o}function he(e,t){return{fullHeight:t,fullWidth:e,height:t,width:e,x:0,y:0}}var ae=P(()=>{});var Tt,At,It,Bt=P(()=>{Tt=`#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`,At=`#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_full;       // full image size in pixels
uniform vec4 u_tile;       // tile x, y (top-left origin), width, height
uniform vec2 u_loop;       // (cos, sin)(phase) * speed * radius
uniform vec2 u_seed;       // seed offset in noise space
uniform float u_scale;
uniform float u_warp;
uniform float u_blur;
uniform float u_grain;
uniform float u_frame;     // grain seed
uniform vec3 u_dither;     // enabled, cell, levels
uniform vec3 u_colors[6];  // OKLab
uniform int u_count;
uniform vec3 u_bg;         // OKLab
uniform vec3 u_pointer;    // x, y in image uv (top-left origin), influence
uniform float u_scroll;    // smoothed scroll velocity * influence

out vec4 outColor;

// 4D simplex noise. Ian McEwan, Stefan Gustavson, Ashima Arts (MIT).
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
float permute(float x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float taylorInvSqrt(float r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec4 grad4(float j, vec4 ip) {
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p, s;
  p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
  return p;
}
float snoise(vec4 v) {
  const vec4 C = vec4(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
  vec4 i = floor(v + dot(v, vec4(0.309016994374947451)));
  vec4 x0 = v - i + dot(i, C.xxxx);
  vec4 i0;
  vec3 isX = step(x0.yzw, x0.xxx);
  vec3 isYZ = step(x0.zww, x0.yyz);
  i0.x = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;
  vec4 i3 = clamp(i0, 0.0, 1.0);
  vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
  vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);
  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;
  i = mod289(i);
  float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = permute(permute(permute(permute(
      i.w + vec4(i1.w, i2.w, i3.w, 1.0))
    + i.z + vec4(i1.z, i2.z, i3.z, 1.0))
    + i.y + vec4(i1.y, i2.y, i3.y, 1.0))
    + i.x + vec4(i1.x, i2.x, i3.x, 1.0));
  vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
  vec4 p0 = grad4(j0, ip);
  vec4 p1 = grad4(j1.x, ip);
  vec4 p2 = grad4(j1.y, ip);
  vec4 p3 = grad4(j1.z, ip);
  vec4 p4 = grad4(j1.w, ip);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  p4 *= taylorInvSqrt(dot(p4, p4));
  vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
    + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));
}

// 2D simplex noise, same authors and licence. About a third of the cost of
// snoise(vec4), so kinds use it for structure and keep the 4D noise for the
// few places that need the field itself to morph.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 10.0) * x); }
float snoise2(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Time coordinates for a noise layer. Every layer moves on its own circle.
vec2 loopAt(float layer) {
  return u_loop + vec2(layer * 1.71, layer * -2.37);
}

// Looping noise: spatial position plus a point on the time circle.
float loopNoise(vec2 p, float layer) {
  return snoise(vec4(p + u_seed, loopAt(layer)));
}

// Three octaves; blur fades out the fine ones.
float fbm(vec2 p, float layer) {
  float fine = 1.0 - 0.85 * u_blur;
  float sum = loopNoise(p, layer);
  sum += 0.5 * fine * loopNoise(p * 2.03 + 17.1, layer + 0.5);
  sum += 0.25 * fine * fine * loopNoise(p * 4.07 - 9.7, layer + 1.0);
  return sum / (1.0 + 0.5 * fine + 0.25 * fine * fine);
}

// The loop point rotated per layer. Translating a field by it is seamless,
// and layers drifting in different directions read as slow morphing.
vec2 drift(float layer) {
  float a = layer * 2.39996;
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c) * u_loop;
}

// Cheap looping noise: a 2D field translated around the loop circle.
float flowNoise(vec2 p, float layer) {
  return snoise2(p + u_seed + drift(layer) + vec2(layer * 7.13, layer * 3.71));
}

// The loop angle as a unit vector, so waves can travel a whole period per
// loop. Frozen when speed is 0.
vec2 loopTurn() {
  float r = length(u_loop);
  return r > 1e-6 ? u_loop / r : vec2(1.0, 0.0);
}

// sin(a - angle), where cs = (cos, sin)(angle).
float turnSin(float a, vec2 cs) {
  return sin(a) * cs.x - cos(a) * cs.y;
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

// tanh that stays finite: some GPUs evaluate tanh(x) as a ratio of exps,
// which is inf/inf = NaN for large x.
float safeTanh(float x) {
  return tanh(clamp(x, -9.0, 9.0));
}

// The brightest lightness and strongest chroma among the supplied colours.
vec2 paletteRange() {
  float l = u_bg.x;
  float c = length(u_bg.yz);
  for (int i = 0; i < 6; i++) {
    if (i >= u_count) break;
    l = max(l, u_colors[i].x);
    c = max(c, length(u_colors[i].yz));
  }
  return vec2(l, c);
}

// Filmic grade in OKLab for the light a kind adds. It is an identity map for
// anything inside the palette's own range, so supplied colours and theme
// tokens render as chosen. Only highlights pushed past the brightest colour
// get a soft shoulder, and only chroma pushed past both the most saturated
// colour and a film-like cap (which eases off toward black and white) rolls off.
vec3 filmGrade(vec3 lab) {
  vec2 range = paletteRange();
  float l = max(lab.x, 0.0);
  float shoulder = max(range.x, 0.8);
  if (l > shoulder) {
    float room = max(1.0 - shoulder, 1e-3);
    l = shoulder + room * safeTanh((l - shoulder) / room);
  }
  float c = length(lab.yz);
  float cap = 0.05 + 0.9 * l * (1.0 - l) * (0.5 + 0.5 * l);
  float knee = max(range.y, 0.6 * cap);
  float top = max(cap, knee + 0.02);
  float soft = c <= knee ? c : knee + (top - knee) * safeTanh((c - knee) / (top - knee));
  float k = c > 1e-5 ? soft / c : 1.0;
  return vec3(l, lab.yz * k);
}

// Darkens the corners in OKLab lightness; amount 0..1.
float vignette(vec2 p, float amount) {
  vec2 q = p / (0.5 * u_full / min(u_full.x, u_full.y));
  return 1.0 - amount * smoothstep(0.35, 1.45, dot(q, q) * 0.55);
}

// Half the frame size in p units; the short side spans -0.5..0.5.
vec2 frameHalf() {
  return 0.5 * u_full / min(u_full.x, u_full.y);
}

float seedAngle() {
  return fract(u_seed.x * 0.1371 + u_seed.y * 0.0713) * 6.28318530718;
}

// Mix in OKLab, then pull chroma back toward the endpoints so midpoints stay vivid.
vec3 labMix(vec3 a, vec3 b, float t) {
  vec3 m = mix(a, b, t);
  float target = mix(length(a.yz), length(b.yz), t);
  float current = length(m.yz);
  if (current > 1e-4) {
    m.yz *= mix(1.0, target / current, 0.75);
  }
  return m;
}

vec3 paletteColor(int i) {
  return u_colors[clamp(i, 0, u_count - 1)];
}

// Smooth ramp through the palette, t in 0..1.
vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(u_count - 1);
  int i = int(floor(x));
  float f = x - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return labMix(paletteColor(i), paletteColor(i + 1), f);
}

// Pointer: a soft lens that pulls the field toward the cursor.
// Scroll: velocity shears the field vertically.
vec2 interact(vec2 p) {
  vec2 half_ = frameHalf();
  vec2 ptr = (u_pointer.xy - 0.5) * 2.0 * half_;
  ptr.y = -ptr.y;
  vec2 d = p - ptr;
  float f = exp(-dot(d, d) * 5.0) * u_pointer.z;
  p -= d * f * 0.45;
  p.y += u_scroll * 0.08 * (0.6 + 0.4 * sin(p.x * 3.0));
  return p;
}
`,It=`
vec3 oklabToLinear(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}

uint hashU(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

float hash01(uvec2 p, uint s) {
  return float(hashU(p.x ^ hashU(p.y ^ hashU(s)))) / 4294967295.0;
}

const float BAYER[16] = float[16](
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

void main() {
  vec2 px = vec2(u_tile.x + gl_FragCoord.x, u_tile.y + (u_tile.w - gl_FragCoord.y));
  bool dither = u_dither.x > 0.5;
  vec2 cell = floor(px / u_dither.y);
  vec2 samplePx = dither ? (cell + 0.5) * u_dither.y : px;

  vec2 uv = samplePx / u_full;
  vec2 p = (samplePx - 0.5 * u_full) / min(u_full.x, u_full.y);
  p.y = -p.y;
  p = interact(p);

  vec3 rgb = linearToSrgb(oklabToLinear(kindColor(p, uv)));

  // Triangular, deterministic grain seeded by the frame. A trace stays on even
  // at grain 0 to break up 8-bit banding.
  uvec2 ip = uvec2(px);
  uint frame = uint(u_frame);
  float n = hash01(ip, frame * 2u + 1u) + hash01(ip, frame * 2u + 2u) - 1.0;
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float amp = u_grain * 0.2 * (0.55 + 0.9 * lum * (1.0 - lum)) + (dither ? 0.0 : 1.0 / 255.0);
  rgb += n * amp;

  if (dither) {
    ivec2 b = ivec2(mod(cell, 4.0));
    float threshold = (BAYER[b.y * 4 + b.x] + 0.5) / 16.0;
    float steps = u_dither.z - 1.0;
    rgb = floor(clamp(rgb, 0.0, 1.0) * steps + threshold) / steps;
  }

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`});function Hr(e){let t=Math.imul(e^2654435769,2246822507);t=Math.imul(t^t>>>13,3266489909),t^=t>>>16;let r=(t&65535)/65535,o=(t>>>16&65535)/65535;return[r*97-48.5,o*97-48.5]}function ve(e,t,r,o,n){let[i,s]=o.phase!==void 0&&e.drift!==void 0?qe(o.phase,e.drift):Ne(o.timeSeconds,e.loopSeconds,e.speed,e.drift),[a,d]=Hr(e.seed),u=Math.tanh((o.scroll?.velocity??0)*e.interaction.scroll)*1.2,m=o.pointer;return{bg:[r[0],r[1],r[2]],blur:e.blur,colors:Array.from({length:6},(f,g)=>{let C=t[g]??[0,0,0];return[C[0],C[1],C[2],0]}),count:e.colors.length,dither:[e.dither.enabled?1:0,e.dither.cell,e.dither.levels],frame:zt(o.frameIndex,e.loopSeconds,o.frameRate),full:[n.fullWidth,n.fullHeight],grain:e.grain,loopv:[i,s],pointer:[m?.x??.5,m?.y??.5,(m?.strength??0)*e.interaction.pointer],scale:e.scale,scroll:u,seed:[a,d],tile:[n.x,n.y,n.width,n.height],warp:Math.min(1.6,e.warp+Math.abs(u)*.5)}}var Ve=P(()=>{ae()});function Qr(e){return typeof OffscreenCanvas<"u"&&e instanceof OffscreenCanvas}function be(e,t){let r={alpha:!0,antialias:!1,depth:!1,powerPreference:"low-power",premultipliedAlpha:!0,preserveDrawingBuffer:t.preserveDrawingBuffer,stencil:!1};try{return Qr(e),e.getContext("webgl2",r)}catch{return null}}function Wt(e,t,r){let o=e.createShader(t);if(!o)throw new X("Unable to create shader");if(e.shaderSource(o,r),e.compileShader(o),!e.getShaderParameter(o,e.COMPILE_STATUS)&&!e.isContextLost()){let n=e.getShaderInfoLog(o)??"";throw e.deleteShader(o),new X(`Shader compile failed: ${n}`)}return o}function $e(e){let{canvas:t,gl:r}=e,o=e.resolveColor??se,n=z(e.params),i=[],s=[0,0,0],a=new Map,d=null,u=null,m=()=>{i=n.colors.map(b=>o(b)),s=o(n.background)},f=()=>{d=r.createBuffer(),u=r.createVertexArray(),r.bindVertexArray(u),r.bindBuffer(r.ARRAY_BUFFER,d),r.bufferData(r.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),r.STATIC_DRAW),r.enableVertexAttribArray(0),r.vertexAttribPointer(0,2,r.FLOAT,!1,0,0),r.bindVertexArray(null)},g=b=>{let S=T(b),h=a.get(S.name);if(h)return h;let B=Wt(r,r.VERTEX_SHADER,Tt),y=Wt(r,r.FRAGMENT_SHADER,`${At}
${S.glsl}
${It}`),p=r.createProgram();if(!p)throw new X("Unable to create program");if(r.attachShader(p,B),r.attachShader(p,y),r.bindAttribLocation(p,0,"a_position"),r.linkProgram(p),r.deleteShader(B),r.deleteShader(y),!r.getProgramParameter(p,r.LINK_STATUS)&&!r.isContextLost()){let k=r.getProgramInfoLog(p)??"";throw r.deleteProgram(p),new X(`Program link failed: ${k}`)}let O=Object.fromEntries(Zr.map(k=>[k,r.getUniformLocation(p,k)])),R={program:p,uniforms:O};return a.set(S.name,R),R},C=()=>{a=new Map,f(),g(n.kind)};return m(),C(),{get canvas(){return t},destroy(){if(!r.isContextLost()){for(let{program:b}of a.values())r.deleteProgram(b);r.deleteBuffer(d),r.deleteVertexArray(u)}a=new Map},gl:r,get params(){return n},refreshColors:m,renderFrame(b,S){if(r.isContextLost())return;let h=S??he(t.width,t.height);(t.width!==h.width||t.height!==h.height)&&(t.width=h.width,t.height=h.height);let{program:B,uniforms:y}=g(n.kind),p=ve(n,i,s,b,h),O=new Float32Array(18);p.colors.forEach(([R,k,ee],$)=>O.set([R,k,ee],$*3)),r.viewport(0,0,h.width,h.height),r.useProgram(B),r.bindVertexArray(u),r.uniform2f(y.u_full,p.full[0],p.full[1]),r.uniform4f(y.u_tile,p.tile[0],p.tile[1],p.tile[2],p.tile[3]),r.uniform2f(y.u_loop,p.loopv[0],p.loopv[1]),r.uniform2f(y.u_seed,p.seed[0],p.seed[1]),r.uniform1f(y.u_scale,p.scale),r.uniform1f(y.u_warp,p.warp),r.uniform1f(y.u_blur,p.blur),r.uniform1f(y.u_grain,p.grain),r.uniform1f(y.u_frame,p.frame),r.uniform3f(y.u_dither,p.dither[0],p.dither[1],p.dither[2]),r.uniform3fv(y.u_colors,O),r.uniform1i(y.u_count,p.count),r.uniform3f(y.u_bg,p.bg[0],p.bg[1],p.bg[2]),r.uniform3f(y.u_pointer,p.pointer[0],p.pointer[1],p.pointer[2]),r.uniform1f(y.u_scroll,p.scroll),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.bindVertexArray(null)},restore:C,setParams(b){let S=b.colors!==void 0||b.background!==void 0;n=ne(n,b),S&&m()}}}var Zr,X,se,ye=P(()=>{ge();K();ae();U();Bt();Ve();Zr=["u_full","u_tile","u_loop","u_seed","u_scale","u_warp","u_blur","u_grain","u_frame","u_dither","u_colors","u_count","u_bg","u_pointer","u_scroll"],X=class extends Error{name="ShaderError"};se=e=>oe(ie(e,typeof document>"u"?null:document.documentElement))});var Yt={};pe(Yt,{composeWgsl:()=>tn,wgslPostlude:()=>$t,wgslPrelude:()=>Vt});function tn(e){return`${Vt}
${e}
${$t}`}var Vt,$t,Kt=P(()=>{Vt=`
struct Uniforms {
  full: vec2f,
  loopv: vec2f,
  tile: vec4f,
  seed: vec2f,
  scale: f32,
  warp: f32,
  blur: f32,
  grain: f32,
  frame: f32,
  count: i32,
  dither: vec3f,
  scroll: f32,
  bg: vec3f,
  pointer: vec3f,
  colors: array<vec4f, 6>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

fn gmod1(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn gmod2(x: vec2f, y: f32) -> vec2f { return x - y * floor(x / y); }

// 4D simplex noise. Ian McEwan, Stefan Gustavson, Ashima Arts (MIT).
fn mod289_4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_1(x: f32) -> f32 { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x: vec4f) -> vec4f { return mod289_4(((x * 34.0) + 10.0) * x); }
fn permute1(x: f32) -> f32 { return mod289_1(((x * 34.0) + 10.0) * x); }
fn taylorInvSqrt4(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn taylorInvSqrt1(r: f32) -> f32 { return 1.79284291400159 - 0.85373472095314 * r; }
fn grad4(j: f32, ip: vec4f) -> vec4f {
  let ones = vec4f(1.0, 1.0, 1.0, -1.0);
  var p: vec4f;
  let pxyz = floor(fract(vec3f(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p = vec4f(pxyz, 1.5 - dot(abs(pxyz), ones.xyz));
  let s = select(vec4f(0.0), vec4f(1.0), p < vec4f(0.0));
  p = vec4f(p.xyz + (s.xyz * 2.0 - 1.0) * s.www, p.w);
  return p;
}
fn snoise(v: vec4f) -> f32 {
  let C = vec4f(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
  var i = floor(v + dot(v, vec4f(0.309016994374947451)));
  let x0 = v - i + dot(i, C.xxxx);
  let isX = step(x0.yzw, x0.xxx);
  let isYZ = step(x0.zww, x0.yyz);
  var i0 = vec4f(isX.x + isX.y + isX.z, 1.0 - isX);
  i0.y += isYZ.x + isYZ.y;
  i0.z += 1.0 - isYZ.x;
  i0.w += 1.0 - isYZ.y;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;
  let i3 = clamp(i0, vec4f(0.0), vec4f(1.0));
  let i2 = clamp(i0 - 1.0, vec4f(0.0), vec4f(1.0));
  let i1 = clamp(i0 - 2.0, vec4f(0.0), vec4f(1.0));
  let x1 = x0 - i1 + C.xxxx;
  let x2 = x0 - i2 + C.yyyy;
  let x3 = x0 - i3 + C.zzzz;
  let x4 = x0 + C.wwww;
  i = mod289_4(i);
  let j0 = permute1(permute1(permute1(permute1(i.w) + i.z) + i.y) + i.x);
  let j1 = permute4(permute4(permute4(permute4(
      i.w + vec4f(i1.w, i2.w, i3.w, 1.0))
    + i.z + vec4f(i1.z, i2.z, i3.z, 1.0))
    + i.y + vec4f(i1.y, i2.y, i3.y, 1.0))
    + i.x + vec4f(i1.x, i2.x, i3.x, 1.0));
  let ip = vec4f(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
  var p0 = grad4(j0, ip);
  var p1 = grad4(j1.x, ip);
  var p2 = grad4(j1.y, ip);
  var p3 = grad4(j1.z, ip);
  var p4 = grad4(j1.w, ip);
  let norm = taylorInvSqrt4(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  p4 *= taylorInvSqrt1(dot(p4, p4));
  var m0 = max(0.6 - vec3f(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3f(0.0));
  var m1 = max(0.6 - vec2f(dot(x3, x3), dot(x4, x4)), vec2f(0.0));
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3f(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
    + dot(m1 * m1, vec2f(dot(p3, x3), dot(p4, x4))));
}

fn mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute3(x: vec3f) -> vec3f { return mod289_3(((x * 34.0) + 10.0) * x); }
fn snoise2(v: vec2f) -> f32 {
  let C = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  var i = floor(v + dot(v, C.yy));
  let x0 = v - i + dot(i, C.xx);
  let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
  var x12 = x0.xyxy + C.xxzz;
  x12 = vec4f(x12.xy - i1, x12.zw);
  i = mod289_2(i);
  let p = permute3(permute3(i.y + vec3f(0.0, i1.y, 1.0)) + i.x + vec3f(0.0, i1.x, 1.0));
  var m = max(0.5 - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m;
  m = m * m;
  let x = 2.0 * fract(p * C.www) - 1.0;
  let h = abs(x) - 0.5;
  let ox = floor(x + 0.5);
  let a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  let g = vec3f(a0.x * x0.x + h.x * x0.y, a0.yz * x12.xz + h.yz * x12.yw);
  return 130.0 * dot(m, g);
}

fn loopAt(layer: f32) -> vec2f {
  return u.loopv + vec2f(layer * 1.71, layer * -2.37);
}

fn loopNoise(p: vec2f, layer: f32) -> f32 {
  return snoise(vec4f(p + u.seed, loopAt(layer)));
}

fn fbm(p: vec2f, layer: f32) -> f32 {
  let fine = 1.0 - 0.85 * u.blur;
  var sum = loopNoise(p, layer);
  sum += 0.5 * fine * loopNoise(p * 2.03 + 17.1, layer + 0.5);
  sum += 0.25 * fine * fine * loopNoise(p * 4.07 - 9.7, layer + 1.0);
  return sum / (1.0 + 0.5 * fine + 0.25 * fine * fine);
}

// The loop angle as a unit vector, so waves can travel a whole period per
// loop. Frozen when speed is 0.
fn loopTurn() -> vec2f {
  let r = length(u.loopv);
  return select(vec2f(1.0, 0.0), u.loopv / r, r > 1e-6);
}

// sin(a - angle), where cs = (cos, sin)(angle).
fn turnSin(a: f32, cs: vec2f) -> f32 {
  return sin(a) * cs.x - cos(a) * cs.y;
}

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

fn drift(layer: f32) -> vec2f {
  return rot2(layer * 2.39996) * u.loopv;
}

fn flowNoise(p: vec2f, layer: f32) -> f32 {
  return snoise2(p + u.seed + drift(layer) + vec2f(layer * 7.13, layer * 3.71));
}

fn safeTanh(x: f32) -> f32 {
  return tanh(clamp(x, -9.0, 9.0));
}

fn paletteRange() -> vec2f {
  var l = u.bg.x;
  var c = length(u.bg.yz);
  for (var i = 0; i < 6; i++) {
    if (i >= u.count) { break; }
    l = max(l, u.colors[i].x);
    c = max(c, length(u.colors[i].yz));
  }
  return vec2f(l, c);
}

fn filmGrade(lab: vec3f) -> vec3f {
  let range = paletteRange();
  var l = max(lab.x, 0.0);
  let shoulder = max(range.x, 0.8);
  if (l > shoulder) {
    let room = max(1.0 - shoulder, 1e-3);
    l = shoulder + room * safeTanh((l - shoulder) / room);
  }
  let c = length(lab.yz);
  let cap = 0.05 + 0.9 * l * (1.0 - l) * (0.5 + 0.5 * l);
  let knee = max(range.y, 0.6 * cap);
  let top = max(cap, knee + 0.02);
  var soft = c;
  if (c > knee) { soft = knee + (top - knee) * safeTanh((c - knee) / (top - knee)); }
  var k = 1.0;
  if (c > 1e-5) { k = soft / c; }
  return vec3f(l, lab.yz * k);
}

fn vignette(p: vec2f, amount: f32) -> f32 {
  let q = p / (0.5 * u.full / min(u.full.x, u.full.y));
  return 1.0 - amount * smoothstep(0.35, 1.45, dot(q, q) * 0.55);
}

fn frameHalf() -> vec2f {
  return 0.5 * u.full / min(u.full.x, u.full.y);
}

fn seedAngle() -> f32 {
  return fract(u.seed.x * 0.1371 + u.seed.y * 0.0713) * 6.28318530718;
}

fn labMix(a: vec3f, b: vec3f, t: f32) -> vec3f {
  var m = mix(a, b, t);
  let target_ = mix(length(a.yz), length(b.yz), t);
  let current = length(m.yz);
  if (current > 1e-4) {
    m = vec3f(m.x, m.yz * mix(1.0, target_ / current, 0.75));
  }
  return m;
}

fn paletteColor(i: i32) -> vec3f {
  return u.colors[clamp(i, 0, u.count - 1)].xyz;
}

fn ramp(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0) * f32(u.count - 1);
  let i = i32(floor(x));
  var f = x - f32(i);
  f = f * f * (3.0 - 2.0 * f);
  return labMix(paletteColor(i), paletteColor(i + 1), f);
}

fn interact(p0: vec2f) -> vec2f {
  var p = p0;
  let half_ = frameHalf();
  var ptr = (u.pointer.xy - 0.5) * 2.0 * half_;
  ptr.y = -ptr.y;
  let d = p - ptr;
  let f = exp(-dot(d, d) * 5.0) * u.pointer.z;
  p -= d * f * 0.45;
  p.y += u.scroll * 0.08 * (0.6 + 0.4 * sin(p.x * 3.0));
  return p;
}
`,$t=`
fn oklabToLinear(lab: vec3f) -> vec3f {
  var l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  var m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  var s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

fn linearToSrgb(c0: vec3f) -> vec3f {
  let c = clamp(c0, vec3f(0.0), vec3f(1.0));
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hashU(x0: u32) -> u32 {
  var x = x0;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

fn hash01(p: vec2u, s: u32) -> f32 {
  return f32(hashU(p.x ^ hashU(p.y ^ hashU(s)))) / 4294967295.0;
}

const BAYER = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  // Top-left origin already, so no flip: GL's (tile.w - fragCoord.y) is this y.
  let px = vec2f(u.tile.x + fragCoord.x, u.tile.y + fragCoord.y);
  let dither = u.dither.x > 0.5;
  let cell = floor(px / u.dither.y);
  let samplePx = select(px, (cell + 0.5) * u.dither.y, dither);

  let uv = samplePx / u.full;
  var p = (samplePx - 0.5 * u.full) / min(u.full.x, u.full.y);
  p.y = -p.y;
  p = interact(p);

  var rgb = linearToSrgb(oklabToLinear(kindColor(p, uv)));

  let ip = vec2u(px);
  let frame = u32(u.frame);
  let n = hash01(ip, frame * 2u + 1u) + hash01(ip, frame * 2u + 2u) - 1.0;
  let lum = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let amp = u.grain * 0.2 * (0.55 + 0.9 * lum * (1.0 - lum)) + select(1.0 / 255.0, 0.0, dither);
  rgb += n * amp;

  if (dither) {
    let b = vec2i(gmod2(cell, 4.0));
    let threshold = (BAYER[b.y * 4 + b.x] + 0.5) / 16.0;
    let steps = u.dither.z - 1.0;
    rgb = floor(clamp(rgb, vec3f(0.0), vec3f(1.0)) * steps + threshold) / steps;
  }

  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
`});var Jt={};pe(Jt,{UNIFORM_BYTES:()=>He,UNIFORM_OFFSETS:()=>jt,acquireSurface:()=>yn,adapterRefusal:()=>Ht,loseWebGPUDevice:()=>En,preferenceChanged:()=>Cn,releaseSurface:()=>wn,setWebGPUMemoryCap:()=>kn,trimSurfaces:()=>_n,webgpuStats:()=>Sn,webgpuStatus:()=>hn,webgpuUnsupported:()=>Pn});function ln(e){return typeof e=="object"&&e!==null&&"requestAdapter"in e&&"getPreferredCanvasFormat"in e}function cn(){if(typeof navigator>"u")return null;let e=Reflect.get(navigator,"gpu");return ln(e)?e:null}function un(e){return typeof e=="object"&&e!==null&&"configure"in e&&"getCurrentTexture"in e}function Xt(e){let t=e.getContext("webgpu");return un(t)?t:null}function Ht(e){let t=e.info,r=t?.isFallbackAdapter??e.isFallbackAdapter;if(r===!0)return"fallback (software) adapter";if(r!==!1)return"adapter does not say whether it is a fallback adapter";let o=`${t?.vendor??""} ${t?.architecture??""}`.trim();return o===""?"adapter reports no vendor or architecture":fn.test(`${o} ${t?.description??""}`)?`software adapter (${o})`:null}function dn(e){let t=e.info;return[t?.vendor,t?.architecture,t?.description].filter(r=>r&&r.length>0).join(" ")||"unknown adapter"}function pn(e){return new Promise(t=>setTimeout(()=>t("timeout"),e))}function mn(e,t){if(typeof OffscreenCanvas>"u")return"no OffscreenCanvas";let r=new OffscreenCanvas(1,1),o=Xt(r);if(!o)return"OffscreenCanvas has no webgpu context";o.configure({alphaMode:"opaque",device:e,format:t});let n=e.createCommandEncoder();n.beginRenderPass({colorAttachments:[{clearValue:{a:1,b:.4,g:.6,r:.2},loadOp:"clear",storeOp:"store",view:o.getCurrentTexture().createView()}]}).end(),e.queue.submit([n.finish()]);let s=new OffscreenCanvas(1,1).getContext("2d",{willReadFrequently:!0});if(!s)return"no 2D canvas";try{s.drawImage(r,0,0)}catch(f){return`drawImage from a WebGPU canvas threw: ${String(f)}`}let[a=0,d=0,u=0]=s.getImageData(0,0,1,1).data;o.unconfigure();let m=(f,g)=>Math.abs(f-g)<=3;return m(a,51)&&m(d,153)&&m(u,102)?null:`copy read back rgb(${a},${d},${u}), wanted rgb(51,153,102)`}function ce(e){x={kind:"failed",reason:e},q.clear(),F()}async function gn(e,t){let r=cn();if(!r){ce("navigator.gpu is missing");return}let n=(async()=>{let a=await r.requestAdapter({powerPreference:"low-power"});if(!a)return{error:"no WebGPU adapter"};let d=tr()==="webgpu"?null:Ht(a);if(d)return{error:d};let u=await a.requestDevice();try{if(!(u.lost instanceof Promise))throw new Error("device.lost is not a promise");let m=r.getPreferredCanvasFormat(),f=mn(u,m);if(f)throw new Error(f);return{adapter:dn(a),device:u,format:m}}catch(m){return u.destroy(),{error:m instanceof Error?m.message:String(m)}}})().catch(a=>({error:String(a)})),i=await Promise.race([n,pn(t)]);if(e!==A){n.then(a=>"device"in a&&a.device.destroy());return}if(i==="timeout"){n.then(a=>"device"in a&&a.device.destroy()),ce(`no device within ${t}ms`);return}if("error"in i){ce(i.error);return}let{device:s}=i;x={...i,generation:e,kind:"ready"},s.lost.then(a=>Qt(e,a.reason)),F()}function Zt(e){A+=1,x={generation:A,kind:"probing"},gn(A,e)}function Qt(e,t){if(x.kind!=="ready"||x.generation!==e)return;let r=x.device;ke+=1,A+=1,q.clear();for(let o of[...E])E.delete(o),o.lease.end();t!=="destroyed"&&ke===1?Zt(on):ce(`device lost (${t}); using WebGL for this session`),r.destroy(),F()}function xn(e,t,r){let o=T(e),n=A;q.set(o.name,"pending");let i=o.wgsl;Promise.all([Promise.resolve().then(()=>(Kt(),Yt)),i?i():Promise.reject(new Error("no WGSL twin"))]).then(([s,a])=>t.createRenderPipelineAsync({fragment:{entryPoint:"fs_main",module:t.createShaderModule({code:s.composeWgsl(a)}),targets:[{format:r}]},layout:"auto",primitive:{topology:"triangle-list"},vertex:{entryPoint:"vs",module:t.createShaderModule({code:sn})}})).then(s=>{n===A&&q.set(o.name,s)},()=>{n===A&&q.set(o.name,"failed")}).finally(F)}function hn(e){if(x.kind==="idle")return Zt(an),"pending";if(x.kind==="failed")return"unavailable";if(x.kind==="probing")return"pending";let t=T(e).name,r=q.get(t);return r===void 0?(xn(t,x.device,x.format),"pending"):r==="failed"?"unavailable":r==="pending"?"pending":"ready"}function Pe(){let e=0;for(let t of E)t.lease.leased&&(e+=t.canvas.width*t.canvas.height*Ze);return e}function vn(e,t,r,o,n){let i=ve(e,t,r,o,n),s=new ArrayBuffer(He),a=new Float32Array(s),d=u=>jt[u]/4;return a.set(i.full,d("full")),a.set(i.loopv,d("loopv")),a.set(i.tile,d("tile")),a.set(i.seed,d("seed")),a[d("scale")]=i.scale,a[d("warp")]=i.warp,a[d("blur")]=i.blur,a[d("grain")]=i.grain,a[d("frame")]=i.frame,new Int32Array(s)[d("count")]=i.count,a.set(i.dither,d("dither")),a[d("scroll")]=i.scroll,a.set(i.bg,d("bg")),a.set(i.pointer,d("pointer")),i.colors.forEach((u,m)=>a.set(u,d("colors")+m*4)),s}function bn(e){for(let t of E)t.lease===e&&E.delete(t)}function yn(e,t=0){if(x.kind!=="ready"||Pe()+t*Ze>_e)return null;for(let i of E)if(i.lease.reusable())return i.lease.leased=!0,i.lease.onLost=e,i.lease;if(E.size>=Ce||Pe()>=_e)return null;let r=new OffscreenCanvas(1,1),o=Xt(r);if(!o)return ce("OffscreenCanvas lost its webgpu context"),null;o.configure({alphaMode:"opaque",device:x.device,format:x.format});let n=new Xe(r,o,x.device,A);return n.leased=!0,n.onLost=e,E.add({canvas:r,context:o,lease:n}),n}function wn(e){for(let t of E)t.lease===e&&t.lease.release()}function _n(e){for(let t of[...E]){if(E.size<=e)return;t.lease.leased||(t.lease.retire(),E.delete(t))}}function kn(e){_e=e>0?e:Qe,F()}function Pn(){return x.kind==="failed"}function Cn(e){e==="webgpu"&&x.kind==="failed"&&ke===0&&(x={kind:"idle"})}function Sn(){return{adapter:x.kind==="ready"?x.adapter:null,leased:[...E].filter(e=>e.lease.leased).length,leasedBytes:Pe(),losses:ke,reason:x.kind==="failed"?x.reason:null,state:x.kind,surfaces:E.size,uniformBuffers:je}}function En(e="unknown"){return x.kind!=="ready"?!1:(Qt(x.generation,e),!0)}var rn,nn,jt,He,_e,Ze,on,an,sn,x,A,ke,E,je,q,fn,Xe,er=P(()=>{K();U();ye();Ve();Se();rn=64,nn=8,jt={bg:80,blur:48,colors:112,count:60,dither:64,frame:56,full:0,grain:52,loopv:8,pointer:96,scale:40,scroll:76,seed:32,tile:16,warp:44},He=208,_e=Qe,Ze=12,on=2e3,an=5e3,sn=`
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`,x={kind:"idle"},A=0,ke=0,E=new Set,je=0,q=new Map;fn=/swiftshader|llvmpipe|lavapipe|software/i;Xe=class{canvas;resolver=se;loaded=null;sourceY=0;leased=!1;onLost=null;lost=!1;params=null;colors=[];background=[0,0,0];uniforms;freed=!1;groups=new Map;surface;context;device;gen;constructor(t,r,o,n){this.surface=t,this.context=r,this.device=o,this.gen=n,this.canvas=t,je+=1,this.uniforms=o.createBuffer({size:He,usage:rn|nn})}isLost(){return this.lost||this.gen!==A||x.kind!=="ready"}setParams(t){this.params=z(t),this.colors=this.params.colors.map(r=>this.resolver(r)),this.background=this.resolver(this.params.background)}renderFrame(t,r){let o=this.params;if(!o||this.isLost())return;let n=q.get(T(o.kind).name);if(!n||typeof n=="string"){this.drop();return}let i=r.height%2,s=r.height+i;if(this.surface.width!==r.width||this.surface.height!==s){let m=(r.width*s-this.surface.width*this.surface.height)*Ze;if(m>0&&Pe()+m>_e){this.drop();return}this.surface.width=r.width,this.surface.height=s}this.sourceY=i,this.device.queue.writeBuffer(this.uniforms,0,vn(o,this.colors,this.background,t,{...r,height:s,y:r.y-i}));let a=this.groups.get(n);a||(a=this.device.createBindGroup({entries:[{binding:0,resource:{buffer:this.uniforms}}],layout:n.getBindGroupLayout(0)}),this.groups.set(n,a));let d=this.device.createCommandEncoder(),u=d.beginRenderPass({colorAttachments:[{clearValue:{a:1,b:0,g:0,r:0},loadOp:"clear",storeOp:"store",view:this.context.getCurrentTexture().createView()}]});u.setPipeline(n),u.setBindGroup(0,a),u.draw(3),u.end(),this.device.queue.submit([d.finish()])}drop(){bn(this),this.free(),this.lost=!0;let t=this.onLost;this.onLost=null,this.leased=!1,t&&queueMicrotask(t)}end(){this.drop()}free(){this.freed||(this.freed=!0,je-=1,this.uniforms.destroy(),x.kind==="ready"&&x.device===this.device&&this.context.unconfigure())}release(){this.leased=!1,this.onLost=null,this.surface.width=1,this.surface.height=1}retire(){this.free()}reusable(){return!this.leased&&!this.lost&&this.gen===A}}});function Je(e){return e==="auto"||e==="webgpu"||e==="webgl2"}function Rn(){if(typeof window>"u")return"auto";try{let e=new URLSearchParams(window.location.search).get("gradient-backend");if(Je(e))return e;let t=window.localStorage.getItem(rr),r=t??window.localStorage.getItem(nr);return t===null&&Je(r)&&(window.localStorage.setItem(rr,r),window.localStorage.removeItem(nr)),Je(r)?r:"auto"}catch{return"auto"}}function sr(e){return et.add(e),()=>et.delete(e)}function F(){for(let e of et)e()}function Mn(){return typeof navigator<"u"&&Reflect.get(navigator,"gpu")!==void 0}function Ln(){ar=!0,Promise.resolve().then(()=>(er(),Jt)).then(e=>{V=e,or>0&&e.setWebGPUMemoryCap(or),F()},e=>{Ee=`could not load the WebGPU backend: ${String(e)}`,F()})}function tt(e){return ir==="webgl2"||T(e).wgsl===void 0?"unavailable":V?V.webgpuStatus(e):Ee!==null?"unavailable":Mn()?(ar||Ln(),"pending"):(Ee="navigator.gpu is missing","unavailable")}function lr(e,t=0){return V?.acquireSurface(e,t)??null}function cr(e){V?.releaseSurface(e)}function rt(e){V?.trimSurfaces(e)}function ur(){return Ee!==null||(V?.webgpuUnsupported()??!1)}function tr(){return ir}var Ce,Qe,rr,nr,ir,V,ar,Ee,or,et,Se=P(()=>{K();Ce=16,Qe=96*1024*1024,rr="gradients:gradient-backend",nr="gcn:gradient-backend";ir=Rn(),V=null,ar=!1,Ee=null,or=0,et=new Set});U();K();K();function Ur(e){let r=`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 ${(.06+e*.16).toFixed(3)}'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`;return`url("data:image/svg+xml,${encodeURIComponent(r)}") 0 0 / 180px 180px repeat`}function Fe(e){let t=T(e.kind).fallbackLayers(e.colors,e.background);return e.grain>=.2&&t.unshift(Ur(e.grain)),[...t,e.background].join(", ")}ge();U();ye();U();ye();var le=8,N=new Set,we=!1,Ye=new Set;function Ot(e){return Ye.add(e),()=>Ye.delete(e)}function Ft(){for(let e of Ye)e()}function Jr(){return typeof OffscreenCanvas<"u"?new OffscreenCanvas(1,1):document.createElement("canvas")}function en(){if(we)return null;let e=Jr(),t=be(e,{preserveDrawingBuffer:!1});if(!t&&typeof document<"u"&&!(e instanceof HTMLCanvasElement)&&(e=document.createElement("canvas"),t=be(e,{preserveDrawingBuffer:!1})),!t)return we=!0,null;let r={resolver:se},o=$e({canvas:e,gl:t,params:We,resolveColor:i=>r.resolver(i)}),n={canvas:e,gl:t,isLost:()=>n.lost||t.isContextLost(),leased:!1,loaded:null,sourceY:0,lost:!1,onLost:null,renderFrame:(i,s)=>o.renderFrame(i,s),renderer:o,setParams:i=>o.setParams(i),get resolver(){return r.resolver},set resolver(i){r.resolver=i}};return e.addEventListener("webglcontextlost",i=>{i.preventDefault(),n.lost=!0,n.loaded=null;let s=n.onLost;n.onLost=null,n.leased=!1,s?.(),Ft()}),e.addEventListener("webglcontextrestored",()=>{if(!N.has(n)){t.getExtension("WEBGL_lose_context")?.loseContext();return}n.lost=!1,n.loaded=null;try{n.renderer.restore()}catch{qt(n)}Ft()}),N.add(n),n}function Dt(){return we}function Ut(e=null){for(let t of N)if(!t.leased&&!t.lost)return t.leased=!0,t.onLost=e,t;if(N.size>=le)return null;try{let t=en();return t&&(t.leased=!0,t.onLost=e),t}catch{return we=!0,null}}function Nt(e){e.leased=!1,e.onLost=null}function qt(e){e.renderer.destroy(),e.gl.getExtension("WEBGL_lose_context")?.loseContext(),N.delete(e)}function Ke(e){for(let t of[...N]){if(N.size<=e)return;t.leased||qt(t)}}Se();var Gn={acquire:(e=null)=>Ut(e),name:"webgl2",release:Nt,supports:()=>!0,unsupported:Dt},zn={acquire:(e=null,t=0)=>lr(e,t),name:"webgpu",release:cr,supports:e=>tt(e)==="ready",unsupported:ur};function H(e){return tt(e)==="unavailable"?Gn:zn}ge();ae();U();Se();var yr=2e6,wr=45e5,it=.5,_r=.3,kr=.5,L=new Map,at=new Set,ue=0,fr=!1,Z=null,Tn=yr;function An(e,t,r){let o=Math.max(0,e.left-t,-e.right),n=Math.max(0,e.top-r,-e.bottom);return Math.hypot(o,n)}var fe=1e3/60,In=4,Bn=fe*1.25,dr=24,pr=83e5,Wn=10,mr=5,Fn=250,Pr=30,On=60,l={cap:Number.POSITIVE_INFINITY,ceiling:Number.POSITIVE_INFINITY,ceilingWindows:0,intervals:[],lastTick:null,slowWindows:0,steadyWindows:0,warmup:Pr,targetMs:fe,displaySamples:[],suppressDisplayLearning:!1},Q=0,nt=0,ot=wr,J=!1,gr=0,xr=.65,Dn=150;function Un(){l.lastTick!==null&&(l.suppressDisplayLearning=!0),l.warmup=Pr,l.intervals=[],l.slowWindows=0,l.steadyWindows=0}function hr({slots:e,budget:t}){let r=e.reduce((s,[a])=>s+a.pixels(),0),o=r>t?Math.max(it,Math.sqrt(t/r)):1,n=0,i=e.map(([s])=>{let a=Math.min(1,Math.max(o,s.minScale()));return n+=s.pixels()*a*a,a});return{halfRate:n>t*1.01,rendered:n,scales:i}}function Cr(){let e=!1,t=0;for(let[r,o]of L)!o.live&&!at.has(r)||r.backend()!=="webgpu"||(r.primary()?e=!0:t+=r.pixels());return e?Math.max(0,pr-t):pr}function Re(){let e=[...L].filter(([i,s])=>(s.live||at.has(i))&&s.visible),t=[{budget:Math.min(ot,Cr())*(J?xr:1),slots:e.filter(([i])=>i.primary())},{budget:Tn*(J?xr:1),slots:e.filter(([i])=>!i.primary())}],r=t.map(hr),o=r.reduce((i,s)=>i+s.rendered,0);if(o>l.cap){let i=l.cap/o;r=t.map((s,a)=>hr({budget:Math.min(s.budget,r[a]?.rendered??0)*i,slots:s.slots}))}Q=0;let n=e.length!==nt;nt=e.length,t.forEach((i,s)=>{let a=r[s];a&&(Q+=a.rendered,i.slots.forEach(([d,u],m)=>{let f=a.scales[m]??1,{halfRate:g}=a;(u.quality.scale!==f||u.quality.halfRate!==g)&&(u.live&&d.primary()&&d.backend()==="webgpu"&&f<u.quality.scale&&(u.live=!1,d.revoke(),_()),u.quality={halfRate:g,scale:f},d.setQuality(u.quality),n=!0)}))}),n&&Un()}function vr(){J||(J=!0,Re()),typeof window<"u"&&typeof window.setTimeout=="function"&&(window.clearTimeout(gr),gr=window.setTimeout(()=>{J=!1,Re()},Dn))}function Nn(e){let t=e>l.targetMs*1.12;if(l.slowWindows=t?l.slowWindows+1:0,l.steadyWindows=e<=l.targetMs*1.05?l.steadyWindows+1:0,t&&(e>l.targetMs*2||l.slowWindows>=2)){l.slowWindows=0,l.ceilingWindows=0,l.ceiling=Math.min(l.ceiling,Q);let o=Math.min(.9,Math.max(.5,l.targetMs/e*.9));l.cap=Math.min(l.cap,Q)*o,_();return}if(l.steadyWindows<mr||Number.isFinite(l.cap)&&Q<l.cap*.98)return;if(!Number.isFinite(l.cap)){ot=Math.min(Cr(),ot*1.2),l.steadyWindows=0,_();return}l.steadyWindows=0;let r=l.ceiling*.9;if(l.cap>=r){if(l.ceilingWindows+=mr,l.ceilingWindows<On)return;l.ceilingWindows=0,l.ceiling*=1.15}l.cap=Math.min(l.cap*1.2,l.ceiling*.9),_()}function qn(e){if(!(e<In||e>Bn)&&(l.displaySamples.push(e),l.displaySamples.length>dr&&l.displaySamples.shift(),l.displaySamples.length>=dr/2)){let t=[...l.displaySamples].sort((r,o)=>r-o);l.targetMs=t[Math.floor((t.length-1)*.25)]??fe}}function Sr(e){let t=l.lastTick;if(e===t||(l.lastTick=e,t===null))return;let r=e-t,o=Me;if(Me=0,r>Fn){l.intervals=[],l.displaySamples=[],l.targetMs=fe;return}if(l.suppressDisplayLearning||qn(r),l.warmup>0){l.warmup-=1,l.warmup===0&&(l.suppressDisplayLearning=!1);return}if(r>l.targetMs*2&&o>0&&o<l.targetMs*.75){l.intervals=[];return}if(l.intervals.push(r),l.intervals.length>=Wn){let n=l.intervals.reduce((i,s)=>i+s,0);Nn(n/l.intervals.length),l.intervals=[]}}function Vn(){ue=0;let e=window.innerWidth,t=window.innerHeight,r=t*kr,o=[];for(let[f,g]of L){let C=f.element.getBoundingClientRect(),b=An(C,e,t),S=C.width>0&&C.height>0,h=S&&b===0;h!==g.visible&&(g.visible=h,f.setVisible(h));let B=!h&&f.primary()&&f.backend()==="webgpu";S&&b<=r&&!B&&o.push({distance:b,slot:f})}o.sort((f,g)=>f.distance-g.distance);let n={webgl2:le,webgpu:Ce},i={webgl2:0,webgpu:0},s=new Map(o.map(({slot:f})=>[f,f.backend()]));for(let f of s.values())i[f]+=1;let a=f=>i[f]>n[f]?n[f]-1:n[f],d={webgl2:0,webgpu:0},u=new Set,m=[];for(let{slot:f}of o){let g=s.get(f)??"webgl2";d[g]<a(g)?(d[g]+=1,u.add(f)):m.push(f)}for(let[f,g]of L)g.live&&!u.has(f)&&(g.live=!1,f.revoke());at=u,Re();for(let f of u){let g=L.get(f);g&&!g.live&&(g.live=f.grant())}for(let f of m)f.paintStill();Ke(d.webgl2+(i.webgl2>n.webgl2?1:0)),rt(d.webgpu+(i.webgpu>n.webgpu?1:0)),Re()}function _(){ue===0&&typeof window<"u"&&(ue=window.requestAnimationFrame(Vn))}function Le(){l.displaySamples=[],l.targetMs=fe,l.intervals=[]}function br(){Le(),Me=0,_()}Ot(_);sr(_);function st(e){let t=L.get(e);t&&(t.live=!1),_()}function Er(e){if(e!==fr)if(fr=e,e){window.addEventListener("scroll",_,{capture:!0,passive:!0}),window.addEventListener("scroll",vr,{capture:!0,passive:!0}),window.addEventListener("resize",br,{passive:!0}),Z=new IntersectionObserver(_,{rootMargin:`${kr*100}% 0px`});for(let t of L.keys())Z.observe(t.element)}else window.removeEventListener("scroll",_,{capture:!0}),window.removeEventListener("scroll",vr,{capture:!0}),window.removeEventListener("resize",br),Z?.disconnect(),Z=null,window.cancelAnimationFrame(ue),ue=0}function Rr(e){L.set(e,{live:!1,quality:{halfRate:!1,scale:1},visible:!1}),Er(!0),Z?.observe(e.element),_()}function lt(e){L.delete(e)&&(Z?.unobserve(e.element),L.size===0?(Er(!1),Ke(0),rt(0)):_())}var $n=0,Me=0,Yn=0;function Mr(e){$n+=e,Me+=e,Yn+=1}function Kn(){let e=0,t=0,r=!1;for(let[,o]of L)o.live&&o.visible&&(e+=o.quality.scale,t+=1,r||=o.quality.halfRate);return{animatingMounts:nt,fpsTier:r?"half":"full",gpuTimeMs:null,mounted:L.size,paceCap:l.cap,rafIntervals:l.intervals.slice(),renderScale:t===0?1:e/t,renderedPixels:Math.round(Q),scrolling:J}}typeof globalThis.window<"u"&&(globalThis.window.__gcnEngineStats=Kn);function ct(e,t,r={}){let o=r.maxDpr??1.5,n=z(t),i=null,s=H(n.kind),a=!1,d=!1,u=0,m=null,f=0,g=0,C=0,b={halfRate:!1,scale:1},S=!1,h=e.getContext("2d"),B=c=>Math.max(1,Math.round(e.width*c))*Math.max(1,Math.round(e.height*c)),y=e.style.background,p=window.matchMedia("(prefers-reduced-motion: reduce)"),O=()=>r.reducedMotion!=="ignore"&&p.matches,R={strength:0,x:.5,y:.5},k={strength:0,x:.5,y:.5},ee=0,$=0,Ge={t:performance.now(),y:window.scrollY},zr=c=>oe(ie(c,e.isConnected?e:null)),ut=()=>{e.style.background=Fe(n)},ft=()=>{if(O())return{frameIndex:0,timeSeconds:0};let c={frameIndex:Math.floor(f*60),timeSeconds:f};return n.drift!==void 0&&(c.phase=g),k.strength>.001&&(c.pointer={...k}),Math.abs($)>.001&&(c.scroll={velocity:$}),c},dt=(c,v,w=1)=>{if(!h||c.isLost()||e.width===0)return;(c.loaded?.owner!==W||c.loaded.version!==C)&&(c.resolver=zr,c.setParams(n),c.loaded={owner:W,version:C});let I=Math.max(1,Math.round(e.width*w)),D=Math.max(1,Math.round(e.height*w));c.renderFrame(v,he(I,D)),!c.isLost()&&(h.clearRect(0,0,e.width,e.height),h.imageSmoothingEnabled=!(n.kind==="dither-field"||n.dither.enabled),h.drawImage(c.canvas,0,c.sourceY,I,D,0,0,e.width,e.height),a=!0)},Y=()=>{if(i){let c=performance.now();dt(i,ft(),b.scale),Mr(performance.now()-c)}},ze=()=>{C+=1,a=!1,i||(h?.clearRect(0,0,e.width,e.height),_())},pt=()=>i!==null&&d&&!document.hidden&&!O(),mt=c=>{u=0,Sr(c);let v=m===null?0:Math.min(.1,(c-m)/1e3);m=c,f+=v,n.drift!==void 0&&(g+=v*n.speed*2*Math.PI/n.loopSeconds,g%=2*Math.PI);let w=1-Math.exp(-v*6);k.x+=(R.x-k.x)*w,k.y+=(R.y-k.y)*w,k.strength+=(R.strength-k.strength)*w,ee*=Math.exp(-v*7),$+=(ee-$)*(1-Math.exp(-v*5)),S=b.halfRate&&!S,S||Y(),pt()&&(u=window.requestAnimationFrame(mt))},de=()=>{if(pt()){u===0&&(m=null,u=window.requestAnimationFrame(mt));return}u!==0&&(window.cancelAnimationFrame(u),u=0),Y()},W={element:e,grant(){return i?!0:h?(s=H(n.kind),i=s.supports(n.kind)?s.acquire(Tr,B(b.scale)):null,i?(Y(),de(),!0):(s.unsupported()&&lt(W),!1)):!1},primary(){return r.primary===!0},minScale(){return n.dither.enabled?1:n.grain>=_r?.8:it},pixels(){return e.width*e.height},backend(){return H(n.kind).name},setQuality(c){b=c,e.dataset.renderScale=c.scale.toFixed(3)},paintStill(){if(i||a||!h)return;let c=H(n.kind),v=c.supports(n.kind)?c.acquire(null,B(1)):null;v&&(dt(v,ft()),c.release(v))},revoke(){u!==0&&(window.cancelAnimationFrame(u),u=0),i&&(s.release(i),i=null)},setVisible(c){d=c,de()}};function Tr(){i=null,u!==0&&(window.cancelAnimationFrame(u),u=0),st(W)}let gt=()=>{let c=Math.min(o,window.devicePixelRatio||1),v=Math.max(1,Math.round(e.clientWidth*c)),w=Math.max(1,Math.round(e.clientHeight*c));(e.width!==v||e.height!==w)&&(e.width=v,e.height=w,a=!1,Y(),Le()),_()},xt=c=>{if(n.interaction.pointer<=0)return;let v=e.getBoundingClientRect();if(v.width===0||v.height===0)return;let w=(c.clientX-v.left)/v.width,I=(c.clientY-v.top)/v.height,D=w>=-.1&&w<=1.1&&I>=-.1&&I<=1.1;R.strength=D?1:0,D&&(R.x=w,R.y=I)},ht=()=>{R.strength=0},vt=()=>{let c=performance.now(),v=Math.max(1,c-Ge.t)/1e3,w=window.scrollY-Ge.y;if(Ge={t:c,y:window.scrollY},n.interaction.scroll<=0)return;let I=w/Math.max(1,window.innerHeight)/v;ee=Math.max(-6,Math.min(6,I))},bt=()=>{Le(),de()},yt=()=>{f=0,g=0,ze(),de()},wt=new MutationObserver(()=>{Ue([...n.colors,n.background])&&(ze(),Y())}),_t=new ResizeObserver(gt);return window.addEventListener("pointermove",xt,{passive:!0}),document.documentElement.addEventListener("pointerleave",ht),window.addEventListener("scroll",vt,{passive:!0}),document.addEventListener("visibilitychange",bt),p.addEventListener("change",yt),wt.observe(document.documentElement,{attributeFilter:["class","style"],attributes:!0}),_t.observe(e),ut(),e.dataset.renderScale=b.scale.toFixed(3),gt(),h&&Rr(W),{setParams(c){let w=c.speed!==void 0&&c.speed!==n.speed&&n.drift===void 0,I="kind"in c&&"colors"in c&&"speed"in c,D=w?{...c,drift:n.speed*.6}:n.drift!==void 0&&c.drift===void 0&&!I?{...c,drift:n.drift}:c;w&&(g=xe(f,n.loopSeconds)),n=ne(n,D),ut(),i&&H(n.kind)!==s&&(W.revoke(),st(W)),ze(),Y()},unmount(){W.revoke(),lt(W),_t.disconnect(),wt.disconnect(),window.removeEventListener("pointermove",xt),document.documentElement.removeEventListener("pointerleave",ht),window.removeEventListener("scroll",vt),document.removeEventListener("visibilitychange",bt),p.removeEventListener("change",yt),h?.clearRect(0,0,e.width,e.height),e.style.background=y,delete e.dataset.renderScale}}}ae();var Xn=z({background:"#010309",blur:.4,colors:["#eef8ff","#8fd0f5","#3d6fd0","#1b1846"],dither:{cell:3,enabled:!1,levels:8},grain:.16,interaction:{pointer:.6,scroll:.25},kind:"radial-glow",loopSeconds:10,scale:1.15,seed:31,speed:.9,warp:.35}),Gr=document.getElementById("glow");Gr instanceof HTMLCanvasElement&&ct(Gr,Xn,{maxDpr:1.5});

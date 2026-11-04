/**
 * WebGL2 compositor of the preview (§1.7, §4.3.8). It draws exactly what the render plan says
 * (`layersAt(t)` from `shared/project/render-plan.ts`), so preview and export agree (R1.48):
 *
 * - the canvas is cleared to the background colour, or filled with the beautify gradient (mixed
 *   in sRGB like CSS, with a ±½-level ordered dither against banding);
 * - each layer, bottom to top, is a quad at its integer destination rect;
 * - its source rect (file pixels) becomes texture coordinates; mirror flips U;
 * - the mask (rectangle, rounded radius in px, circle) is the render plan's anti-aliased
 *   coverage function (`MASK_COVERAGE_GLSL`) evaluated per fragment at pixel centres, the same
 *   function the export rasterizes into its mask PNG;
 * - layers blend with premultiplied alpha.
 *
 * A layer without a decoded frame (still decoding, or offline media) is drawn as a flat
 * placeholder so the layout stays visible. The geometry helpers are pure and unit-tested.
 *
 * The frame-render export (`renderer/render`) draws with this same compositor into an offscreen
 * target (`drawOffscreen`) and converts that to yuv420p on the GPU (`readYuv420`), so the export
 * shows exactly what the preview draws.
 */
import {
  unpackYuv,
  yuvFrameBytes,
  yuvTarget,
  YUV709_GLSL,
} from '../../../shared/export/frame-render';
import { MASK_COVERAGE_GLSL } from '../../../shared/project/render-plan';
import {
  GRADIENT_GLSL,
  gradientAxis,
  maskUniforms,
  parseHexColor,
  quadUvs,
  quadVertices,
  shadowGeometry,
  type CompositeItemOf,
  type SceneBackground,
  type Size,
} from './compositor-math';

export type { SceneBackground, Size } from './compositor-math';

/** One layer to draw (see `compositor-math.ts`), with a picture WebGL can upload. */
export type CompositeItem = CompositeItemOf<TexImageSource>;

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_canvasHeight;
uniform int u_solid;
uniform vec4 u_color;
uniform float u_opacity;
// 0: the layer (border inside its edge); 1: its drop shadow (u_color, edge blurred by u_blur).
uniform int u_pass;
uniform float u_border;
uniform vec4 u_borderColor;
uniform float u_blur;
out vec4 outColor;
${MASK_COVERAGE_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x - u_rect.x, (u_canvasHeight - gl_FragCoord.y) - u_rect.y);
  float d = csMaskDistance(p, u_rect.zw, u_radius);
  if (u_pass == 1) {
    float shadow = (1.0 - smoothstep(-u_blur, u_blur, d)) * u_color.a * u_opacity;
    outColor = vec4(u_color.rgb * shadow, shadow);
    return;
  }
  float coverage = (1.0 - smoothstep(-0.5, 0.5, d)) * u_opacity;
  vec4 color = u_solid == 1 ? u_color : vec4(texture(u_tex, v_uv).rgb, 1.0);
  if (u_border > 0.0) {
    float inner = 1.0 - smoothstep(-0.5, 0.5, d + u_border);
    color.rgb = mix(color.rgb, u_borderColor.rgb, (1.0 - inner) * u_borderColor.a);
  }
  outColor = vec4(color.rgb * coverage, coverage);
}
`;

/** The beautify gradient over the whole canvas (drawn without blending). */
const GRADIENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform vec2 u_dir;
uniform float u_len;
uniform vec4 u_from;
uniform vec4 u_to;
out vec4 outColor;
${GRADIENT_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  float t = csGradientT(p, u_size, u_dir, u_len);
  // Interleaved gradient noise: a fixed per-pixel dither, the same in preview and export.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 color = mix(u_from.rgb, u_to.rgb, t) + (noise - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
`;

/**
 * Converts the composited picture (u_src, canvas size, bottom-up) to yuv420p packed four samples
 * per texel (`yuvTarget` in `shared/export/frame-render.ts`). Each output sample is the source
 * sampled at its pixel centre (Y) or at the centre of its 2×2 block (U, V), bilinearly, so at
 * canvas size chroma is the mean of the four pixels.
 */
const YUV_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_src;
// Output frame size; the source (canvas size) is sampled proportionally.
uniform vec2 u_size;
out vec4 outColor;
${YUV709_GLSL}
vec3 at(vec2 topDown) {
  return texture(u_src, vec2(topDown.x / u_size.x, 1.0 - topDown.y / u_size.y)).rgb;
}
void main() {
  vec2 texel = floor(gl_FragCoord.xy);
  float w = u_size.x;
  float h = u_size.y;
  vec4 result = vec4(0.0);
  for (int c = 0; c < 4; c++) {
    float x = texel.x * 4.0 + float(c);
    float value = 0.0;
    if (texel.y < h) {
      if (x < w) value = csYuv709(at(vec2(x + 0.5, texel.y + 0.5))).x;
    } else {
      bool isU = texel.y < h * 1.5;
      float row = texel.y - (isU ? h : h * 1.5);
      if (x < w * 0.5) {
        vec3 yuv = csYuv709(at(vec2(2.0 * x + 1.0, 2.0 * row + 1.0)));
        value = isU ? yuv.y : yuv.z;
      }
    }
    result[c] = value;
  }
  outColor = result;
}
`;

const FULLSCREEN_VERTICES = new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]);

const PLACEHOLDER: [number, number, number, number] = [0.22, 0.24, 0.28, 1];
const NO_COLOR: [number, number, number, number] = [0, 0, 0, 0];

/** A colour texture with its framebuffer. */
interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('compositor: cannot create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`compositor: shader error: ${gl.getShaderInfoLog(shader) ?? ''}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`compositor: link error: ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  return program;
}

export interface LumaProbe {
  /** Mean luma 0–255 over the canvas. */
  meanLuma: number;
  /** Fraction of pixels brighter than 16 (not black). */
  nonBlack: number;
}

/** The composited picture, RGBA rows top to bottom, at canvas resolution (parity test, R1.48). */
export interface PixelCapture {
  width: number;
  height: number;
  rgba: Uint8Array<ArrayBuffer>;
}

export class WebGlCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly posBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly textures: WebGLTexture[] = [];
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private size: Size;
  /** Offscreen picture at canvas size, and the packed yuv420p target (export only). */
  private picture: Target | null = null;
  private yuv: Target | null = null;
  private yuvProgram: WebGLProgram | null = null;
  private gradientProgram: WebGLProgram | null = null;

  constructor(private readonly canvas: OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('compositor: WebGL2 is not available');
    this.gl = gl;
    this.size = { width: canvas.width, height: canvas.height };
    this.program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.posBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.uniforms = Object.fromEntries(
      [
        'u_tex',
        'u_rect',
        'u_radius',
        'u_canvasHeight',
        'u_solid',
        'u_color',
        'u_opacity',
        'u_pass',
        'u_border',
        'u_borderColor',
        'u_blur',
      ].map((name) => [name, gl.getUniformLocation(this.program, name)]),
    );
  }

  resize(size: Size): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.size = { ...size };
  }

  /** Draws one frame: background, then the layers bottom to top. */
  draw(background: SceneBackground, items: readonly CompositeItem[]): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.drawBound(background, items);
  }

  /** Draws one frame into the offscreen picture (export); read it with `readYuv420`. */
  drawOffscreen(background: SceneBackground, items: readonly CompositeItem[]): void {
    const { gl } = this;
    const picture = this.target('picture', this.size.width, this.size.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, picture.framebuffer);
    this.drawBound(background, items);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * The offscreen picture as one yuv420p frame of `out` size (BT.709 limited range; see
   * `shared/export/frame-render.ts`). Scales from the canvas size bilinearly when they differ.
   */
  readYuv420(out: Size, into?: Uint8Array): Uint8Array {
    const { gl } = this;
    const picture = this.picture;
    if (!picture) throw new Error('compositor: nothing drawn offscreen');
    const layout = yuvTarget(out.width, out.height);
    const yuv = this.target('yuv', layout.width, layout.height);
    this.yuvProgram ??= link(gl, VERTEX_SHADER, YUV_FRAGMENT_SHADER);
    const program = this.yuvProgram;
    gl.bindFramebuffer(gl.FRAMEBUFFER, yuv.framebuffer);
    gl.viewport(0, 0, layout.width, layout.height);
    gl.disable(gl.BLEND);
    gl.useProgram(program);
    this.bindAttribute(this.posBuffer, 'a_pos', FULLSCREEN_VERTICES, program);
    this.bindAttribute(this.uvBuffer, 'a_uv', FULLSCREEN_VERTICES, program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, picture.texture);
    gl.uniform1i(gl.getUniformLocation(program, 'u_src'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_size'), out.width, out.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const readback = new Uint8Array(layout.width * layout.height * 4);
    gl.readPixels(0, 0, layout.width, layout.height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return unpackYuv(
      readback,
      out.width,
      out.height,
      into ?? new Uint8Array(yuvFrameBytes(out.width, out.height)),
    );
  }

  private drawBound(background: SceneBackground, items: readonly CompositeItem[]): void {
    const { gl } = this;
    gl.viewport(0, 0, this.size.width, this.size.height);
    const [r, g, b] = parseHexColor(
      background.type === 'color' ? background.color : background.from,
    );
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (background.type === 'gradient') this.drawGradient(background);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uniforms.u_canvasHeight ?? null, this.size.height);
    gl.uniform1i(this.uniforms.u_tex ?? null, 0);

    items.forEach((item, index) => {
      const { rect, radius } = maskUniforms(item.layer);
      const opacity = item.layer.opacity ?? 1;
      gl.uniform1f(this.uniforms.u_radius ?? null, radius);
      gl.uniform1f(this.uniforms.u_opacity ?? null, opacity);
      if (item.layer.shadow && opacity > 0) {
        const shadow = shadowGeometry(item.layer.destRect, item.layer.shadow);
        this.bindAttribute(this.posBuffer, 'a_pos', quadVertices(shadow.quad, this.size));
        const m = shadow.maskRect;
        gl.uniform4f(this.uniforms.u_rect ?? null, m.x, m.y, m.width, m.height);
        gl.uniform1i(this.uniforms.u_pass ?? null, 1);
        gl.uniform1f(this.uniforms.u_blur ?? null, shadow.blur);
        gl.uniform4f(this.uniforms.u_color ?? null, ...parseHexColor(item.layer.shadow.color));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.uniform1i(this.uniforms.u_pass ?? null, 0);
      const border = item.layer.border;
      gl.uniform1f(this.uniforms.u_border ?? null, border ? border.widthPx : 0);
      const borderColor = border ? parseHexColor(border.color) : NO_COLOR;
      gl.uniform4f(this.uniforms.u_borderColor ?? null, ...borderColor);
      this.bindAttribute(this.posBuffer, 'a_pos', quadVertices(item.layer.destRect, this.size));
      this.bindAttribute(
        this.uvBuffer,
        'a_uv',
        quadUvs(item.layer.sourceRect, item.mediaSize, item.layer.mirror),
      );
      gl.uniform4f(this.uniforms.u_rect ?? null, ...rect);
      const solid = item.frame === null || item.layer.offline;
      gl.uniform1i(this.uniforms.u_solid ?? null, solid ? 1 : 0);
      gl.uniform4f(this.uniforms.u_color ?? null, ...PLACEHOLDER);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(index));
      if (!solid && item.frame) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, item.frame);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
  }

  private drawGradient(gradient: Extract<SceneBackground, { type: 'gradient' }>): void {
    const { gl } = this;
    this.gradientProgram ??= link(gl, VERTEX_SHADER, GRADIENT_FRAGMENT_SHADER);
    const program = this.gradientProgram;
    gl.useProgram(program);
    this.bindAttribute(this.posBuffer, 'a_pos', FULLSCREEN_VERTICES, program);
    const axis = gradientAxis(gradient.angleDeg, this.size);
    const at = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform2f(at('u_size'), this.size.width, this.size.height);
    gl.uniform2f(at('u_dir'), axis.dirX, axis.dirY);
    gl.uniform1f(at('u_len'), axis.length);
    gl.uniform4f(at('u_from'), ...parseHexColor(gradient.from));
    gl.uniform4f(at('u_to'), ...parseHexColor(gradient.to));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Reads the frame just drawn (call in the same task as `draw`). */
  probe(): LumaProbe {
    const { gl } = this;
    const { width, height } = this.size;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luma =
        0.2126 * (pixels[i] ?? 0) + 0.7152 * (pixels[i + 1] ?? 0) + 0.0722 * (pixels[i + 2] ?? 0);
      sum += luma;
      if (luma > 16) bright += 1;
    }
    const count = width * height;
    return { meanLuma: count ? sum / count : 0, nonBlack: count ? bright / count : 0 };
  }

  /** The frame just drawn as top-down RGBA (call in the same task as `draw`). */
  capture(): PixelCapture {
    const { gl } = this;
    const { width, height } = this.size;
    const bottomUp = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
    const rgba = new Uint8Array(bottomUp.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      rgba.set(bottomUp.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    return { width, height, rgba };
  }

  dispose(): void {
    const { gl } = this;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const target of [this.picture, this.yuv]) {
      if (!target) continue;
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    if (this.yuvProgram) gl.deleteProgram(this.yuvProgram);
    if (this.gradientProgram) gl.deleteProgram(this.gradientProgram);
    gl.deleteBuffer(this.posBuffer);
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteProgram(this.program);
  }

  private texture(index: number): WebGLTexture {
    const existing = this.textures[index];
    if (existing) return existing;
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.textures[index] = texture;
    return texture;
  }

  /** The offscreen picture or yuv target, (re)created at `width × height`. */
  private target(kind: 'picture' | 'yuv', width: number, height: number): Target {
    const existing = this[kind];
    if (existing?.width === width && existing.height === height) return existing;
    const { gl } = this;
    if (existing) {
      gl.deleteFramebuffer(existing.framebuffer);
      gl.deleteTexture(existing.texture);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    const filter = kind === 'picture' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`compositor: the ${kind} target is incomplete`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const created = { framebuffer, texture, width, height };
    this[kind] = created;
    return created;
  }

  private bindAttribute(
    buffer: WebGLBuffer,
    name: string,
    data: Float32Array,
    program: WebGLProgram = this.program,
  ): void {
    const { gl } = this;
    const location = gl.getAttribLocation(program, name);
    if (location < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }
}

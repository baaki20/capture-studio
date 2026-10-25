/**
 * WebGL2 compositor of the preview (§1.7, §4.3.8). It draws exactly what the render plan says
 * (`layersAt(t)` from `shared/project/render-plan.ts`), so preview and export agree (R1.48):
 *
 * - the canvas is cleared to the timeline background colour;
 * - each layer, bottom to top, is a quad at its integer destination rect;
 * - its source rect (file pixels) becomes texture coordinates; mirror flips U;
 * - the mask (rectangle, rounded radius in px, circle) is the render plan's anti-aliased
 *   coverage function (`MASK_COVERAGE_GLSL`) evaluated per fragment at pixel centres, the same
 *   function the export rasterizes into its mask PNG;
 * - layers blend with premultiplied alpha.
 *
 * A layer without a decoded frame (still decoding, or offline media) is drawn as a flat
 * placeholder so the layout stays visible. The geometry helpers are pure and unit-tested.
 */
import { MASK_COVERAGE_GLSL, type VideoLayer } from '../../../shared/project/render-plan';
import { maskUniforms, parseHexColor, quadUvs, quadVertices, type Size } from './compositor-math';

export type { Size } from './compositor-math';

export interface CompositeItem {
  layer: VideoLayer;
  /** The decoded picture, or null for a placeholder. */
  frame: TexImageSource | null;
  /** The media's picture size (`Media.video`), the space of `layer.sourceRect`. */
  mediaSize: Size;
}

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
out vec4 outColor;
${MASK_COVERAGE_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x - u_rect.x, (u_canvasHeight - gl_FragCoord.y) - u_rect.y);
  float coverage = csMaskCoverage(p, u_rect.zw, u_radius);
  vec4 color = u_solid == 1 ? u_color : vec4(texture(u_tex, v_uv).rgb, 1.0);
  outColor = vec4(color.rgb * coverage, coverage);
}
`;

const PLACEHOLDER: [number, number, number, number] = [0.22, 0.24, 0.28, 1];

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

export interface LumaProbe {
  /** Mean luma 0–255 over the canvas. */
  meanLuma: number;
  /** Fraction of pixels brighter than 16 (not black). */
  nonBlack: number;
}

export class WebGlCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly posBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly textures: WebGLTexture[] = [];
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private size: Size;

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
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`compositor: link error: ${gl.getProgramInfoLog(program) ?? ''}`);
    }
    this.program = program;
    this.posBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.uniforms = Object.fromEntries(
      ['u_tex', 'u_rect', 'u_radius', 'u_canvasHeight', 'u_solid', 'u_color'].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
  }

  resize(size: Size): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.size = { ...size };
  }

  /** Draws one frame: background, then the layers bottom to top. */
  draw(background: string, items: readonly CompositeItem[]): void {
    const { gl } = this;
    gl.viewport(0, 0, this.size.width, this.size.height);
    const [r, g, b] = parseHexColor(background);
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uniforms.u_canvasHeight ?? null, this.size.height);
    gl.uniform1i(this.uniforms.u_tex ?? null, 0);

    items.forEach((item, index) => {
      this.bindAttribute(this.posBuffer, 'a_pos', quadVertices(item.layer.destRect, this.size));
      this.bindAttribute(
        this.uvBuffer,
        'a_uv',
        quadUvs(item.layer.sourceRect, item.mediaSize, item.layer.mirror),
      );
      const { rect, radius } = maskUniforms(item.layer);
      gl.uniform4f(this.uniforms.u_rect ?? null, ...rect);
      gl.uniform1f(this.uniforms.u_radius ?? null, radius);
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

  dispose(): void {
    const { gl } = this;
    for (const t of this.textures) gl.deleteTexture(t);
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

  private bindAttribute(buffer: WebGLBuffer, name: string, data: Float32Array): void {
    const { gl } = this;
    const location = gl.getAttribLocation(this.program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }
}

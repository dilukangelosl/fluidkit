// Thin WebGL2 helpers: program compilation with uniform reflection, ping-pong FBOs.

export interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation>
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): Program {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('fluidkit shader compile: ' + gl.getShaderInfoLog(s))
    return s
  }
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc))
  gl.bindAttribLocation(program, 0, 'aPosition')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error('fluidkit program link: ' + gl.getProgramInfoLog(program))
  const uniforms: Record<string, WebGLUniformLocation> = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)!
    uniforms[info.name.replace('[0]', '')] = gl.getUniformLocation(program, info.name)!
  }
  return { program, uniforms }
}

export interface FBO {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  attach(unit: number): number
  dispose(): void
}

export function createFBO(
  gl: WebGL2RenderingContext,
  w: number, h: number,
  internalFormat: number, format: number, type: number, filter: number,
): FBO {
  const texture = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.viewport(0, 0, w, h)
  gl.clear(gl.COLOR_BUFFER_BIT)

  return {
    texture, fbo,
    width: w, height: h,
    texelSizeX: 1 / w, texelSizeY: 1 / h,
    attach(unit) {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      return unit
    },
    dispose() {
      gl.deleteTexture(texture)
      gl.deleteFramebuffer(fbo)
    },
  }
}

export interface DoubleFBO {
  read: FBO
  write: FBO
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  swap(): void
  dispose(): void
}

export function createDoubleFBO(
  gl: WebGL2RenderingContext,
  w: number, h: number,
  internalFormat: number, format: number, type: number, filter: number,
): DoubleFBO {
  let a = createFBO(gl, w, h, internalFormat, format, type, filter)
  let b = createFBO(gl, w, h, internalFormat, format, type, filter)
  return {
    get read() { return a },
    get write() { return b },
    width: w, height: h,
    texelSizeX: 1 / w, texelSizeY: 1 / h,
    swap() { const t = a; a = b; b = t },
    dispose() { a.dispose(); b.dispose() },
  }
}

// WebGL-accelerated pixel processing worker

const VERTEX_SHADER = `#version 100
precision highp float;

attribute vec2 aPosition;
varying vec2 vTexCoord;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTexCoord = (aPosition + 1.0) * 0.5;
}
`;

const FRAGMENT_SHADER = `#version 100
precision highp float;

uniform sampler2D uTexture;
uniform float uUseLevels;
uniform float uLevelsMin;
uniform float uInvLevelsRange;
uniform float uInvGamma;
uniform float uDesaturate;
uniform float uDoC2A;
uniform float uDoCErase;
uniform float uAlphaThresh;
uniform float uInvAlphaFeather;

varying vec2 vTexCoord;

void main() {
  vec4 color = texture2D(uTexture, vTexCoord);
  vec3 rgb = color.rgb;
  float alpha = color.a;

  if (alpha <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // levels & gamma transformation
  if (uUseLevels > 0.5) {
    vec3 normalized = clamp((rgb - vec3(uLevelsMin)) * uInvLevelsRange, 0.0, 1.0);
    rgb = pow(normalized, vec3(uInvGamma));
  }

  // luminance desaturation (Rec. 709 standard coefficients)
  if (uDesaturate > 0.5) {
    float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = vec3(lum);
  }

  // Color-to-alpha or color erase
  float brightness = max(rgb.r, max(rgb.g, rgb.b));

  if (uDoCErase > 0.5) {
    float alphaFactor = brightness;
    alpha *= alphaFactor;
    if (alphaFactor > 0.0) {
      rgb /= alphaFactor;
    } else {
      rgb = vec3(0.0);
    }
  } else if (uDoC2A > 0.5) {
    if (brightness <= uAlphaThresh) {
      alpha = 0.0;
    } else {
      float alphaFactor = min(1.0, (brightness - uAlphaThresh) * uInvAlphaFeather);
      alpha *= alphaFactor;
      if (alphaFactor > 0.0) {
        rgb /= alphaFactor;
      }
    }
  }

  gl_FragColor = vec4(rgb, alpha);
}
`;

function createShaderProgram(gl) {
  const vertShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertShader, VERTEX_SHADER);
  gl.compileShader(vertShader);

  if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
    console.error('[worker] Vertex shader error:', gl.getShaderInfoLog(vertShader));
    return null;
  }

  const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragShader, FRAGMENT_SHADER);
  gl.compileShader(fragShader);

  if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
    console.error('[worker] Fragment shader error:', gl.getShaderInfoLog(fragShader));
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[worker] Program link error:', gl.getProgramInfoLog(program));
    return null;
  }

  return program;
}

let glState = null;

function initWebGL(width, height) {
  if (glState) {
    if (glState.width !== width || glState.height !== height) {
      resizeWebGLState(width, height);
    }
    return glState;
  }

  try {
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext('webgl', { 
      preserveDrawingBuffer: true, 
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      powerPreference: 'high-performance'
    });

    if (!gl) return null;

    const program = createShaderProgram(gl);
    if (!program) return null;

    const uniforms = {
      uUseLevels: gl.getUniformLocation(program, 'uUseLevels'),
      uLevelsMin: gl.getUniformLocation(program, 'uLevelsMin'),
      uInvLevelsRange: gl.getUniformLocation(program, 'uInvLevelsRange'),
      uInvGamma: gl.getUniformLocation(program, 'uInvGamma'),
      uDesaturate: gl.getUniformLocation(program, 'uDesaturate'),
      uDoC2A: gl.getUniformLocation(program, 'uDoC2A'),
      uDoCErase: gl.getUniformLocation(program, 'uDoCErase'),
      uAlphaThresh: gl.getUniformLocation(program, 'uAlphaThresh'),
      uInvAlphaFeather: gl.getUniformLocation(program, 'uInvAlphaFeather'),
      uTexture: gl.getUniformLocation(program, 'uTexture')
    };

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(aPosition);

    const inputTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const renderTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, renderTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, renderTexture, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return null;
    }

    glState = {
      canvas, gl, program, uniforms, posBuffer, inputTexture, renderTexture, framebuffer, width, height
    };

    return glState;
  } catch (err) {
    console.warn('[worker] WebGL init failed:', err);
    return null;
  }
}

function resizeWebGLState(width, height) {
  if (!glState) return;
  const { canvas, gl, renderTexture, framebuffer } = glState;
  canvas.width = width;
  canvas.height = height;

  gl.bindTexture(gl.TEXTURE_2D, renderTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.viewport(0, 0, width, height);

  glState.width = width;
  glState.height = height;
}

function processPixelsWebGL(imageData, config) {
  try {
    const state = initWebGL(imageData.width, imageData.height);
    if (!state) return null;

    const { gl, program, uniforms, inputTexture, framebuffer, width, height } = state;

    gl.viewport(0, 0, width, height);
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    // pre-calculate uniforms
    const lvMin = config.levelsMin / 255.0;
    const lvMax = config.levelsMax / 255.0;
    const range = lvMax - lvMin;
    const invRange = range > 0.0001 ? 1.0 / range : 0.0;
    const invGamma = config.levelsGamma > 0 ? 1.0 / config.levelsGamma : 1.0;
    const useLevels = (config.levelsMin !== 0 || config.levelsMax !== 255 || config.levelsGamma !== 1.0);
    const feather = Math.max(1.0, config.alphaFeather);

    gl.uniform1f(uniforms.uUseLevels, useLevels ? 1.0 : 0.0);
    gl.uniform1f(uniforms.uLevelsMin, lvMin);
    gl.uniform1f(uniforms.uInvLevelsRange, invRange);
    gl.uniform1f(uniforms.uInvGamma, invGamma);
    gl.uniform1f(uniforms.uDesaturate, config.desaturate ? 1.0 : 0.0);
    gl.uniform1f(uniforms.uDoC2A, config.c2a ? 1.0 : 0.0);
    gl.uniform1f(uniforms.uDoCErase, config.cErase ? 1.0 : 0.0);
    gl.uniform1f(uniforms.uAlphaThresh, config.alphaThresh / 255.0);
    gl.uniform1f(uniforms.uInvAlphaFeather, 255.0 / feather);
    gl.uniform1i(uniforms.uTexture, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const output = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);

    return new ImageData(output, width, height);
  } catch (err) {
    console.warn('[worker] WebGL processing failed, falling back to CPU:', err);
    return null;
  }
}

function processPixelsCPU(imageData, config) {
  const d = imageData.data;
  const n = d.length;

  const desat = config.desaturate;
  const lvMin = config.levelsMin;
  const lvGam = config.levelsGamma;
  const lvMax = config.levelsMax;
  const doC2A = config.c2a;
  const doCErase = config.cErase;
  const thresh = config.alphaThresh;
  const feather = Math.max(1, config.alphaFeather);
  const invFeather = 1 / feather;

  const useLevels = (lvMin !== 0 || lvMax !== 255 || lvGam !== 1.0);
  let lut = null;

  if (useLevels) {
    lut = new Uint8Array(256);
    const invGamma = 1 / lvGam;
    const range = lvMax - lvMin;
    for (let i = 0; i < 256; i++) {
      let v = i;
      if (v < lvMin) v = lvMin;
      else if (v > lvMax) v = lvMax;
      lut[i] = range === 0 ? 0 : Math.pow((v - lvMin) / range, invGamma) * 255;
    }
  }

  for (let i = 0; i < n; i += 4) {
    let a = d[i + 3];
    if (a === 0) continue; // skip zero alpha pixels instantly

    let r = d[i], g = d[i + 1], b = d[i + 2];

    if (useLevels) {
      r = lut[r];
      g = lut[g];
      b = lut[b];
    }

    if (desat) {
      const lum = (54 * r + 183 * g + 19 * b) >> 8;
      r = g = b = lum;
    }

    if (doCErase) {
      const brightness = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const alphaFactor = brightness / 255;
      a = (alphaFactor * a) | 0;
      if (alphaFactor > 0) {
        const norm = 1 / alphaFactor;
        r = Math.min(255, (r * norm) | 0);
        g = Math.min(255, (g * norm) | 0);
        b = Math.min(255, (b * norm) | 0);
      } else {
        r = g = b = 0;
      }
    } else if (doC2A) {
      const brightness = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (brightness <= thresh) {
        a = 0;
      } else if (brightness < thresh + feather) {
        const alphaFactor = (brightness - thresh) * invFeather;
        a = (alphaFactor * a) | 0;
        if (alphaFactor > 0) {
          const norm = 1 / alphaFactor;
          r = Math.min(255, (r * norm) | 0);
          g = Math.min(255, (g * norm) | 0);
          b = Math.min(255, (b * norm) | 0);
        }
      }
    }

    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }

  return imageData;
}

self.onmessage = async (event) => {
  if (event.data.type === 'export') {
    const { 
      targetW, targetH, bg2,
      scale, offsetX, offsetY, scaledCenterX, scaledCenterY,
      mapBitmap, mapW, mapH, scaledMapW, scaledMapH, mapZoom, mapOffX, mapOffY,
      stormBitmap, renderedW, renderedH, opacity, blendMode, stormRotation, flipH, flipV,
      mime, quality
    } = event.data;

    const exportCanvas = new OffscreenCanvas(targetW, targetH);
    const ctx = exportCanvas.getContext('2d');

    ctx.fillStyle = bg2;
    ctx.fillRect(0, 0, targetW, targetH);

    if (mapBitmap) {
      const mapOffsetX = offsetX + mapOffX * scale;
      const mapOffsetY = offsetY + mapOffY * scale;
      let drawX = mapOffsetX % scaledMapW;
      if (drawX > 0) drawX -= scaledMapW;

      for (; drawX < targetW; drawX += scaledMapW) {
        const destX = Math.max(0, drawX);
        const destRight = Math.min(targetW, drawX + scaledMapW);
        const destW = destRight - destX;

        if (destW > 0) {
          const srcX = (destX - drawX) / (mapZoom * scale);
          const srcW = destW / (mapZoom * scale);
          ctx.drawImage(mapBitmap, srcX, 0, srcW, mapH, destX, mapOffsetY, destW, scaledMapH);
        }
      }
    }

    if (stormBitmap) {
      const scaledRenderedW = renderedW * scale;
      const scaledRenderedH = renderedH * scale;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = blendMode;
      ctx.translate(scaledCenterX, scaledCenterY);
      ctx.rotate((stormRotation * Math.PI) / 180);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.drawImage(stormBitmap, -scaledRenderedW / 2, -scaledRenderedH / 2, scaledRenderedW, scaledRenderedH);
      ctx.restore();
    }

    const blob = await exportCanvas.convertToBlob({ type: mime, quality });

    if (mapBitmap && typeof mapBitmap.close === 'function') mapBitmap.close();
    if (stormBitmap && typeof stormBitmap.close === 'function') stormBitmap.close();

    self.postMessage({ type: 'export_done', blob });
    return;
  }

  const { imageData, config } = event.data;
  if (!imageData) return;

  let processedData = processPixelsWebGL(imageData, config);
  if (!processedData) {
    processedData = processPixelsCPU(imageData, config);
  }

  self.postMessage({ imageData: processedData }, [processedData.data.buffer]);
};
// WebGL-accelerated pixel processing worker

const FRAGMENT_SHADER = `#version 100
precision highp float;

uniform sampler2D uTexture;
uniform bool uUseLevels;
uniform float uLevelsMin;
uniform float uLevelsGamma;
uniform float uLevelsMax;
uniform bool uDesaturate;
uniform bool uDoC2A;
uniform bool uDoCErase;
uniform float uAlphaThresh;
uniform float uAlphaFeather;

varying vec2 vTexCoord;

float applyLevels(float v) {
  float range = uLevelsMax - uLevelsMin;
  if (range == 0.0) return 0.0;
  float normalized = (v - uLevelsMin) / range;
  normalized = clamp(normalized, 0.0, 1.0);
  return pow(normalized, 1.0 / uLevelsGamma);
}

void main() {
  vec4 color = texture2D(uTexture, vTexCoord);
  vec3 rgb = color.rgb;
  float alpha = color.a;

  // apply levels
  if (uUseLevels) {
    rgb.r = applyLevels(rgb.r);
    rgb.g = applyLevels(rgb.g);
    rgb.b = applyLevels(rgb.b);
  }

  // apply desaturation
  if (uDesaturate) {
    float lum = dot(rgb, vec3(0.2118, 0.7154, 0.0745)); // rec709
    rgb = vec3(lum);
  }

  // apply color-to-alpha or color erase
  float brightness = max(rgb.r, max(rgb.g, rgb.b));

  if (uDoCErase) {
    float alphaFactor = brightness;
    alpha *= alphaFactor;
    if (alphaFactor > 0.0) {
      rgb /= alphaFactor;
    } else {
      rgb = vec3(0.0);
    }
  } else if (uDoC2A) {
    if (brightness <= uAlphaThresh / 255.0) {
      alpha = 0.0;
    } else if (brightness < (uAlphaThresh + uAlphaFeather) / 255.0) {
      float featherRange = uAlphaFeather / 255.0;
      float alphaFactor = (brightness - uAlphaThresh / 255.0) / featherRange;
      alpha *= alphaFactor;
      if (alphaFactor > 0.0) {
        rgb /= alphaFactor;
      }
    }
  }

  gl_FragColor = vec4(rgb, alpha);
}
`;

const VERTEX_SHADER = `#version 100
precision highp float;

attribute vec2 aPosition;
varying vec2 vTexCoord;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTexCoord = (aPosition + 1.0) / 2.0;
}
`;

function createShaderProgram(gl) {
  const vertShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertShader, VERTEX_SHADER);
  gl.compileShader(vertShader);

  if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
    console.error('Vertex shader error:', gl.getShaderInfoLog(vertShader));
    return null;
  }

  const fragShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragShader, FRAGMENT_SHADER);
  gl.compileShader(fragShader);

  if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
    console.error('Fragment shader error:', gl.getShaderInfoLog(fragShader));
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    return null;
  }

  return program;
}

function processPixelsWebGL(imageData, config) {
  try {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true });

    if (!gl) {
      console.warn('WebGL unavailable, falling back to CPU');
      return null;
    }

    // create shader program
    const program = createShaderProgram(gl);
    if (!program) return null;

    // create texture from ImageData
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // create framebuffer
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

    const rendertarget = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rendertarget);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imageData.width, imageData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rendertarget, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('Framebuffer incomplete, falling back to CPU');
      return null;
    }

    // setup viewport and quad
    gl.viewport(0, 0, imageData.width, imageData.height);
    gl.useProgram(program);

    // create and bind position buffer
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(aPosition);

    // set uniforms
    const useLevels = config.levelsMin !== 0 || config.levelsMax !== 255 || config.levelsGamma !== 1.0;
    gl.uniform1i(gl.getUniformLocation(program, 'uUseLevels'), useLevels);
    gl.uniform1f(gl.getUniformLocation(program, 'uLevelsMin'), config.levelsMin / 255.0);
    gl.uniform1f(gl.getUniformLocation(program, 'uLevelsGamma'), config.levelsGamma);
    gl.uniform1f(gl.getUniformLocation(program, 'uLevelsMax'), config.levelsMax / 255.0);
    gl.uniform1i(gl.getUniformLocation(program, 'uDesaturate'), config.desaturate ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uDoC2A'), config.c2a ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uDoCErase'), config.cErase ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uAlphaThresh'), config.alphaThresh);
    gl.uniform1f(gl.getUniformLocation(program, 'uAlphaFeather'), config.alphaFeather);

    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

    // render
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // read pixels
    const output = new Uint8ClampedArray(imageData.width * imageData.height * 4);
    gl.readPixels(0, 0, imageData.width, imageData.height, gl.RGBA, gl.UNSIGNED_BYTE, output);

    // cleanup
    gl.deleteTexture(texture);
    gl.deleteTexture(rendertarget);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteBuffer(posBuffer);
    gl.deleteProgram(program);

    return new ImageData(output, imageData.width, imageData.height);
  } catch (err) {
    console.warn('WebGL processing failed, falling back to CPU:', err);
    return null;
  }
}

// CPU fallback
function processPixelsCPU(imageData, config) {
  const d = imageData.data;
  const n = d.length;

  const desat   = config.desaturate;
  const lvMin   = config.levelsMin;
  const lvGam   = config.levelsGamma;
  const lvMax   = config.levelsMax;
  const doC2A   = config.c2a;
  const doCErase= config.cErase;
  const thresh  = config.alphaThresh;
  const feather = Math.max(1, config.alphaFeather);

  if (lvMin !== 0 || lvMax !== 255 || lvGam !== 1.0) {
    for (let i = 0; i < n; i += 4) {
      d[i]   = Math.pow((d[i] - lvMin) / (lvMax - lvMin), 1 / lvGam) * 255;
      d[i+1] = Math.pow((d[i+1] - lvMin) / (lvMax - lvMin), 1 / lvGam) * 255;
      d[i+2] = Math.pow((d[i+2] - lvMin) / (lvMax - lvMin), 1 / lvGam) * 255;
    }
  }

  if (desat) {
    for (let i = 0; i < n; i += 4) {
      const lum = (54 * d[i] + 183 * d[i+1] + 19 * d[i+2]) >> 8;
      d[i] = d[i+1] = d[i+2] = lum;
    }
  }

  if (doCErase) {
    for (let i = 0; i < n; i += 4) {
      let r = d[i], g = d[i+1], b = d[i+2];
      let brightness = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const alphaFactor = brightness / 255;
      d[i+3] = (alphaFactor * d[i+3]) | 0;
      if (alphaFactor > 0) {
        const norm = 1 / alphaFactor;
        d[i]   = Math.min(255, r * norm) | 0;
        d[i+1] = Math.min(255, g * norm) | 0;
        d[i+2] = Math.min(255, b * norm) | 0;
      } else {
        d[i] = d[i+1] = d[i+2] = 0;
      }
    }
  } else if (doC2A) {
    for (let i = 0; i < n; i += 4) {
      let r = d[i], g = d[i+1], b = d[i+2];
      let brightness = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (brightness <= thresh) {
        d[i+3] = 0;
      } else if (brightness < thresh + feather) {
        const alphaFactor = (brightness - thresh) / feather;
        d[i+3] = (alphaFactor * 255) | 0;
        if (alphaFactor > 0) {
          const norm = 1 / alphaFactor;
          d[i]   = Math.min(255, r * norm) | 0;
          d[i+1] = Math.min(255, g * norm) | 0;
          d[i+2] = Math.min(255, b * norm) | 0;
        }
      }
    }
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
      ctx.rotate(stormRotation * Math.PI / 180);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.drawImage(stormBitmap, -scaledRenderedW / 2, -scaledRenderedH / 2, scaledRenderedW, scaledRenderedH);
      ctx.restore();
    }

    const blob = await exportCanvas.convertToBlob({ type: mime, quality });
    self.postMessage({ type: 'export_done', blob });
    return;
  }

  const { imageData, config } = event.data;
  if (!imageData) return;

  // try WebGL first, fallback to CPU
  let processedData = processPixelsWebGL(imageData, config);
  if (!processedData) {
    processedData = processPixelsCPU(imageData, config);
  }

  self.postMessage({ imageData: processedData }, [processedData.data.buffer]);
};

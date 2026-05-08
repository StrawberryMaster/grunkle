// The web worker
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
  const invFeather = 1 / feather;

  // build levels LUT
  const useLevels = (lvMin !== 0 || lvMax !== 255 || lvGam !== 1.0);
  let lut;
  if (useLevels) {
    lut = new Uint8Array(256);
    const invGamma = 1 / lvGam;
    const range = lvMax - lvMin;
    for (let i = 0; i < 256; i++) {
      let v = i;
      if (v < lvMin) v = lvMin;
      else if (v > lvMax) v = lvMax;
      if (range === 0) v = 0;
      else v = Math.pow((v - lvMin) / range, invGamma) * 255;
      lut[i] = v;
    }
  }

  // process pixels
  if (useLevels) {
    for (let i = 0; i < n; i += 4) {
      d[i]   = lut[d[i]];
      d[i+1] = lut[d[i+1]];
      d[i+2] = lut[d[i+2]];
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
        const alphaFactor = (brightness - thresh) * invFeather;
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

  // send processed data back
  self.postMessage({ imageData }, [imageData.data.buffer]);
};

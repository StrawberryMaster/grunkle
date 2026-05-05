/**
 * Image Processing Web Worker
 * Offloads CPU-intensive pixel processing to a background thread
 */

self.onmessage = (event) => {
  const { imageData, config } = event.data;
  if (!imageData) return;

  const d = imageData.data;
  const n = d.length;

  const desat   = config.desaturate;
  const lvMin   = config.levelsMin;
  const lvGam   = config.levelsGamma;
  const lvMax   = config.levelsMax;
  const doC2A   = config.c2a;
  const thresh  = config.alphaThresh;
  const feather = Math.max(1, config.alphaFeather);
  const invFeather = 1 / feather;

  // Build Levels LUT
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

  // Process pixels
  for (let i = 0; i < n; i += 4) {
    let r = d[i], g = d[i+1], b = d[i+2];

    if (useLevels) {
      r = lut[r]; g = lut[g]; b = lut[b];
    }

    if (desat) {
      const lum = (54 * r + 183 * g + 19 * b) >> 8;
      r = g = b = lum;
    }

    if (doC2A) {
      let brightness = r;
      if (g > brightness) brightness = g;
      if (b > brightness) brightness = b;
      
      if (brightness <= thresh) {
        d[i+3] = 0;
      } else if (brightness < thresh + feather) {
        const alphaFactor = (brightness - thresh) * invFeather;
        d[i+3] = (alphaFactor * 255) | 0;
        if (alphaFactor > 0) {
          const norm = 1 / alphaFactor;
          r = Math.min(255, r * norm) | 0;
          g = Math.min(255, g * norm) | 0;
          b = Math.min(255, b * norm) | 0;
        }
      }
    }

    d[i] = r; d[i+1] = g; d[i+2] = b;
  }

  // Send processed data back
  self.postMessage({ imageData });
};

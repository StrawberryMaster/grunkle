/* ──────────────────────────────────────────────────────────────
   THEME TOGGLE
────────────────────────────────────────────────────────────── */
const btnTheme = document.getElementById('btn-theme');
btnTheme.addEventListener('click', () => {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') === 'dark';
  root.setAttribute('data-theme', isDark ? 'light' : 'dark');
  btnTheme.textContent = isDark ? '🌙' : '☀️';
});

// service worker registration for offline caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => console.log('Service worker registered:', reg))
      .catch(err => console.warn('Service worker registration failed:', err));
  });
}

/* ──────────────────────────────────────────────────────────────
   WORKER & STATE
────────────────────────────────────────────────────────────── */
let fallbackCanvas = null;
let processingWorker = null;
let isProcessing = false;
let procStartTime = 0;

let activeExportResolve = null;

// initialize web worker for offloading pixel processing
try {
  processingWorker = new Worker('./data/worker-process-webgl.js');
  processingWorker.onmessage = (event) => {
    if (event.data.type === 'export_done') {
      if (activeExportResolve) activeExportResolve(event.data.blob);
      return;
    }
    const { imageData } = event.data;
    offCtx.putImageData(imageData, 0, 0);
    processedStorm = offscreen;
    S.perfProc = performance.now() - procStartTime;
    updatePerfUI();
    S.dirty = true;
    document.getElementById('btn-export').disabled = false;
    document.getElementById('btn-export-download').disabled = false;
    document.getElementById('btn-copy-canvas').disabled = false;
    isProcessing = false;
  };
} catch (e) {
  console.warn('Web Worker not available, using main thread:', e);
}

const rawState = {
  mapLoaded: false, stormLoaded: false,
  stormX: 0, stormY: 0, stormScale: 50, stormRotation: 0,
  flipH: false, flipV: false, opacity: 1.0, blendMode: 'source-over',
  desaturate: true, c2a: true, cErase: false, alphaThresh: 30, alphaFeather: 80,
  levelsMin: 0, levelsGamma: 1.0, levelsMax: 255,
  mapOffX: 0, mapOffY: 0, mapZoom: 1.0,
  dragging: false, dragMode: null,
  dragStartX: 0, dragStartY: 0, dragStartStormX: 0, dragStartStormY: 0, dragStartMapX: 0, dragStartMapY: 0,
  dirty: true, perfProc: 0, perfRend: 0,
  renderedW: 0, renderedH: 0
};

const S = new Proxy(rawState, {
  set(target, prop, value) {
    if (target[prop] === value) return true;
    target[prop] = value;
    if (prop !== 'dirty' && !prop.startsWith('perf') && !prop.startsWith('drag')) {
      target.dirty = true;
    }
    return true;
  }
});

const UI = {
  numSx: document.getElementById('num-sx'),
  numSy: document.getElementById('num-sy'),
  numSw: document.getElementById('num-sw'),
  numSh: document.getElementById('num-sh'),
  stormBox: document.getElementById('storm-box'),
  hudCoords: document.getElementById('hud-coords'),
  hudMode: document.getElementById('hud-mode')
};

// state trackers to throttle DOM writes
let lastLat = null, lastLon = null, lastMode = null;
let lastBoxL = null, lastBoxT = null, lastBoxW = null, lastBoxH = null;

const appLayout = document.getElementById('app');
const btnToggleLeft = document.getElementById('btn-toggle-left');
const btnToggleRight = document.getElementById('btn-toggle-right');

function resizeAfterTransition() {
  resize();
  lowQualityRender = false;
  S.dirty = true;
}

btnToggleLeft.addEventListener('click', () => {
  appLayout.classList.toggle('hide-left');
  btnToggleLeft.textContent = appLayout.classList.contains('hide-left') ? '▶' : '◀';
  // listen for end of CSS animation, then resize
  const handler = () => {
    resizeAfterTransition();
    appLayout.removeEventListener('transitionend', handler);
  };
  appLayout.addEventListener('transitionend', handler);
  // fallback timeout in case transitionend doesn't fire
  setTimeout(() => appLayout.removeEventListener('transitionend', handler), 350);
});

btnToggleRight.addEventListener('click', () => {
  appLayout.classList.toggle('hide-right');
  btnToggleRight.textContent = appLayout.classList.contains('hide-right') ? '◀' : '▶';
  const handler = () => {
    resizeAfterTransition();
    appLayout.removeEventListener('transitionend', handler);
  };
  appLayout.addEventListener('transitionend', handler);
  setTimeout(() => appLayout.removeEventListener('transitionend', handler), 350);
});

/* ──────────────────────────────────────────────────────────────
   CANVAS SETUP
────────────────────────────────────────────────────────────── */
const canvasArea = document.getElementById('canvas-area');
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d', { alpha: false });
let W = 0, H = 0;
let canvasRect = null;

const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');
let processedStorm = null;

const mapImg = new Image();
mapImg.crossOrigin = 'anonymous';
const stormImg = new Image();

let mapBitmap = null;
let mapBaseW = 0;
let mapBaseH = 0;
const mapMipLevels = [];
let mapMipBuildToken = 0;
let mapInteractionTimer = null;
let imageSmoothing = true;
let lowQualityRender = false;

function resize() {
  canvasRect = canvasArea.getBoundingClientRect();
  W = canvasRect.width; H = canvasRect.height;
  canvas.width = W; canvas.height = H;
  S.dirty = true;
}

new ResizeObserver(resize).observe(canvasArea);
resize();

/* ──────────────────────────────────────────────────────────────
   MAP LOADING
────────────────────────────────────────────────────────────── */
const MAP_URL = './files/bg21600-nxtgen.jpg';

const mapStatus = document.getElementById('map-status');
const badgeMap = document.getElementById('badge-map');

function setMapStatus(state, msg) {
  mapStatus.className = state;
  mapStatus.textContent = msg;
  badgeMap.innerHTML = `<span class="accent-letter">M</span> MAP: ` + (state === 'loaded' ? 'OK' : state.toUpperCase());
  badgeMap.className = 'badge' + (state === 'loaded' ? ' active' : '');
}

function clearMapMipLevels() {
  while (mapMipLevels.length) {
    const level = mapMipLevels.pop();
    if (level && level.ownsSource && level.source && typeof level.source.close === 'function') {
      level.source.close();
    }
  }
}

function buildMapMipLevelsAsync(baseSource, baseW, baseH) {
  clearMapMipLevels();
  if (!baseSource || !baseW || !baseH) return;

  const token = ++mapMipBuildToken;
  mapMipLevels.push({ source: baseSource, width: baseW, height: baseH, factor: 1, ownsSource: false });

  const MIN_DIM = 512;
  let prevSource = baseSource;
  let prevW = baseW;
  let prevH = baseH;

  const schedule = (fn) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 60 });
    } else {
      setTimeout(() => fn(null), 0);
    }
  };

  const step = async () => {
    if (token !== mapMipBuildToken) return;

    if (Math.min(prevW, prevH) > MIN_DIM) {
      const nextW = Math.max(MIN_DIM, Math.floor(prevW / 2));
      const nextH = Math.max(MIN_DIM, Math.floor(prevH / 2));
      if (nextW === prevW && nextH === prevH) return;

      try {
        let nextSource;
        if (typeof createImageBitmap === 'function') {
          nextSource = await createImageBitmap(prevSource, {
            resizeWidth: nextW,
            resizeHeight: nextH,
            resizeQuality: 'high'
          });
        } else {
          const levelCanvas = document.createElement('canvas');
          levelCanvas.width = nextW;
          levelCanvas.height = nextH;
          const levelCtx = levelCanvas.getContext('2d', { alpha: false });
          levelCtx.imageSmoothingEnabled = true;
          levelCtx.imageSmoothingQuality = 'high';
          levelCtx.drawImage(prevSource, 0, 0, nextW, nextH);
          nextSource = levelCanvas;
        }

        const factor = nextW / baseW;
        mapMipLevels.push({ source: nextSource, width: nextW, height: nextH, factor, ownsSource: true });
        prevSource = nextSource;
        prevW = nextW;
        prevH = nextH;

        schedule(step);
      } catch (err) {
        console.warn('Failed to generate map mip level:', err);
      }
    } else {
      S.dirty = true;
    }
  };

  schedule(step);
}

function getMapSourceLevel() {
  if (!mapMipLevels.length) {
    const baseSource = fallbackCanvas || mapBitmap || mapImg;
    const baseW = mapBaseW || (fallbackCanvas ? fallbackCanvas.width : mapImg.naturalWidth);
    const baseH = mapBaseH || (fallbackCanvas ? fallbackCanvas.height : mapImg.naturalHeight);
    if (!baseSource || !baseW || !baseH) return null;
    return { source: baseSource, width: baseW, height: baseH, factor: 1 };
  }

  let best = mapMipLevels[0];
  let bestErr = Math.abs((S.mapZoom / best.factor) - 1);

  for (let i = 1; i < mapMipLevels.length; i++) {
    const level = mapMipLevels[i];
    const err = Math.abs((S.mapZoom / level.factor) - 1);
    if (err < bestErr) {
      best = level;
      bestErr = err;
    }
  }

  return best;
}

function markMapInteraction() {
  lowQualityRender = true;
  clearTimeout(mapInteractionTimer);
  mapInteractionTimer = setTimeout(() => {
    lowQualityRender = false;
    S.dirty = true;
  }, 120);
}

function zoomMapAt(screenX, screenY, zoomFactor) {
  const oldZoom = S.mapZoom;
  const newZoom = Math.max(0.05, Math.min(8, oldZoom * zoomFactor));
  if (newZoom === oldZoom) return;

  const mapSpaceX = (screenX - S.mapOffX) / oldZoom;
  const mapSpaceY = (screenY - S.mapOffY) / oldZoom;
  S.mapOffX = screenX - mapSpaceX * newZoom;
  S.mapOffY = screenY - mapSpaceY * newZoom;
  S.mapZoom = newZoom;
  updateZoomLabel();
}

mapImg.onload = () => {
  S.mapLoaded = true;
  setMapStatus('loaded', `Loaded base · ${mapImg.naturalWidth}×${mapImg.naturalHeight}`);
  mapBaseW = mapImg.naturalWidth;
  mapBaseH = mapImg.naturalHeight;
  fitMap();
  S.dirty = true;
  document.getElementById('empty-hint').style.display = 'none';

  if (typeof createImageBitmap === 'function') {
    createImageBitmap(mapImg).then((bitmap) => {
      if (mapBitmap && typeof mapBitmap.close === 'function') mapBitmap.close();
      mapBitmap = bitmap;
      buildMapMipLevelsAsync(mapBitmap, mapBaseW, mapBaseH);
      S.dirty = true;
    }).catch(() => {
      buildMapMipLevelsAsync(mapImg, mapBaseW, mapBaseH);
    });
  } else {
    buildMapMipLevelsAsync(mapImg, mapBaseW, mapBaseH);
  }
};
mapImg.onerror = () => {
  setMapStatus('error', 'CORS blocked — using procedural fallback map');
  drawFallbackMap();
};

function fitMap() {
  const baseW = mapBaseW || mapImg.naturalWidth;
  const baseH = mapBaseH || mapImg.naturalHeight;
  if (!baseW || !baseH) return;

  const aspect = baseW / baseH;
  if (W / H > aspect) {
    S.mapZoom = H / baseH;
  } else {
    S.mapZoom = W / baseW;
  }
  S.mapOffX = (W - baseW * S.mapZoom) / 2;
  S.mapOffY = (H - baseH * S.mapZoom) / 2;
  updateZoomLabel();
}

setMapStatus('loading', 'Loading map…');
mapImg.src = MAP_URL;

let lastZoomText = '';
const valMapZoom = document.getElementById('val-mapzoom');

function updateZoomLabel() {
  const txt = Math.round(S.mapZoom * 100) + '%';
  if (lastZoomText !== txt) {
    valMapZoom.textContent = txt;
    lastZoomText = txt;
  }
}

function drawFallbackMap() {
  fallbackCanvas = document.createElement('canvas');
  fallbackCanvas.width = 2048; fallbackCanvas.height = 1024;
  const fc = fallbackCanvas.getContext('2d');
  const g = fc.createLinearGradient(0, 0, 0, 1024);
  g.addColorStop(0, '#7590a3'); g.addColorStop(0.5, '#506e85'); g.addColorStop(1, '#7590a3');
  fc.fillStyle = g; fc.fillRect(0, 0, 2048, 1024);
  fc.strokeStyle = 'rgba(255,255,255,0.15)'; fc.lineWidth = 1;
  for (let x = 0; x < 2048; x += 128) { fc.beginPath(); fc.moveTo(x, 0); fc.lineTo(x, 1024); fc.stroke(); }
  for (let y = 0; y < 1024; y += 64) { fc.beginPath(); fc.moveTo(0, y); fc.lineTo(2048, y); fc.stroke(); }
  S.mapLoaded = true;
  mapBaseW = fallbackCanvas.width;
  mapBaseH = fallbackCanvas.height;
  S.mapZoom = W / 2048; S.mapOffX = 0; S.mapOffY = (H - 1024 * S.mapZoom) / 2;
  buildMapMipLevelsAsync(fallbackCanvas, mapBaseW, mapBaseH);
  updateZoomLabel(); S.dirty = true;
}

/* ──────────────────────────────────────────────────────────────
   FILE DROP / UPLOAD
────────────────────────────────────────────────────────────── */
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

canvas.addEventListener('dragover', e => e.preventDefault());
canvas.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  stormImg.onload = () => {
    S.stormLoaded = true;
    S.stormX = W / 2; S.stormY = H / 2;

    const info = document.getElementById('storm-info');
    info.style.display = 'block';
    info.innerHTML = `<strong>${file.name}</strong><br>${stormImg.naturalWidth}×${stormImg.naturalHeight} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;

    const badgeStorm = document.getElementById('badge-storm');
    badgeStorm.innerHTML = `<span class="accent-letter">S</span> STORM: ${stormImg.naturalWidth}×${stormImg.naturalHeight}`;
    badgeStorm.className = 'badge active';
    document.getElementById('perf-val-px').textContent = (stormImg.naturalWidth * stormImg.naturalHeight / 1e6).toFixed(2) + ' MP';['sl-scale', 'sl-rotate', 'sl-opacity', 'btn-flip-h', 'btn-flip-v', 'btn-reset-tr', 'btn-center', 'btn-apply'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    processStorm();
    URL.revokeObjectURL(url);
  };
  stormImg.src = url;
}

/* ──────────────────────────────────────────────────────────────
   PIXEL PROCESSING PIPELINE
────────────────────────────────────────────────────────────── */
function processStorm() {
  if (!S.stormLoaded || isProcessing) return;

  procStartTime = performance.now();
  const MAX = 1600;
  let sw = stormImg.naturalWidth, sh = stormImg.naturalHeight;
  if (sw > MAX || sh > MAX) {
    const r = Math.min(MAX / sw, MAX / sh);
    sw = Math.round(sw * r); sh = Math.round(sh * r);
  }

  if (offscreen.width !== sw || offscreen.height !== sh) {
    offscreen.width = sw; offscreen.height = sh;
  }

  offCtx.clearRect(0, 0, sw, sh);
  offCtx.drawImage(stormImg, 0, 0, sw, sh);
  const imgData = offCtx.getImageData(0, 0, sw, sh);

  isProcessing = true;

  if (processingWorker) {
    processingWorker.postMessage({
      imageData: imgData,
      config: {
        desaturate: S.desaturate,
        levelsMin: S.levelsMin,
        levelsGamma: S.levelsGamma,
        levelsMax: S.levelsMax,
        c2a: S.c2a,
        cErase: S.cErase,
        alphaThresh: S.alphaThresh,
        alphaFeather: S.alphaFeather
      }
    }, [imgData.data.buffer]);
  } else {
    processPixelsMainThread(imgData);
  }
}

function processPixelsMainThread(imgData) {
  const d = imgData.data;
  const n = d.length;
  const desat = S.desaturate;
  const lvMin = S.levelsMin;
  const lvGam = S.levelsGamma;
  const lvMax = S.levelsMax;
  const doC2A = S.c2a;
  const doCErase = S.cErase;
  const thresh = S.alphaThresh;
  const feather = Math.max(1, S.alphaFeather);
  const invFeather = 1 / feather;

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
        d[i + 3] = 0;
      } else if (brightness < thresh + feather) {
        const alphaFactor = (brightness - thresh) / feather;
        d[i + 3] = (alphaFactor * 255) | 0;
        if (alphaFactor > 0) {
          const norm = 1 / alphaFactor;
          d[i]   = Math.min(255, r * norm) | 0;
          d[i+1] = Math.min(255, g * norm) | 0;
          d[i+2] = Math.min(255, b * norm) | 0;
        }
      }
    }
  }

  offCtx.putImageData(imgData, 0, 0);
  processedStorm = offscreen;
  S.perfProc = performance.now() - procStartTime;
  updatePerfUI();
  S.dirty = true;
  document.getElementById('btn-export').disabled = false;
  document.getElementById('btn-export-download').disabled = false;
  document.getElementById('btn-copy-canvas').disabled = false;
  isProcessing = false;
}


/* ──────────────────────────────────────────────────────────────
   RENDER LOOP
────────────────────────────────────────────────────────────── */
function render() {
  if (!S.dirty) return;
  S.dirty = false;

  const t0 = performance.now();

  ctx.imageSmoothingEnabled = imageSmoothing && !lowQualityRender;

  // clear canvas
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg2');
  ctx.fillRect(0, 0, W, H);

  const mapLevel = S.mapLoaded ? getMapSourceLevel() : null;
  if (mapLevel) {
    const src = mapLevel.source;
    const srcW = mapLevel.width;
    const srcH = mapLevel.height;
    const srcFactor = mapLevel.factor || 1;
    const mw = mapBaseW * S.mapZoom;
    const mh = mapBaseH * S.mapZoom;

    // calculate fractional tile offset
    let startX = S.mapOffX % mw;
    if (startX > 0) startX -= mw; // ensure we always cover the left screen edge

    for (let drawX = startX; drawX < W; drawX += mw) {
      // calculate screen visibility boundaries
      const destX = Math.max(0, drawX);
      const destY = Math.max(0, S.mapOffY);
      const destRight = Math.min(W, drawX + mw);
      const destBottom = Math.min(H, S.mapOffY + mh);

      const destW = destRight - destX;
      const destH = destBottom - destY;

      // skip if completely off-screen
      if (destW <= 0 || destH <= 0) continue;

      // map destination pixels back to source pixels
      const srcCropXWorld = (destX - drawX) / S.mapZoom;
      const srcCropYWorld = (destY - S.mapOffY) / S.mapZoom;
      const srcCropWWorld = destW / S.mapZoom;
      const srcCropHWorld = destH / S.mapZoom;

      const srcCropX = srcCropXWorld * srcFactor;
      const srcCropY = srcCropYWorld * srcFactor;
      const srcCropW = srcCropWWorld * srcFactor;
      const srcCropH = srcCropHWorld * srcFactor;

      // safeguard floats
      const safeSrcX = Math.max(0, Math.min(srcCropX, srcW));
      const safeSrcY = Math.max(0, Math.min(srcCropY, srcH));
      const safeSrcW = Math.min(srcCropW, srcW - safeSrcX);
      const safeSrcH = Math.min(srcCropH, srcH - safeSrcY);

      if (safeSrcW > 0 && safeSrcH > 0) {
        ctx.drawImage(
          src,
          safeSrcX, safeSrcY, safeSrcW, safeSrcH, // source cropping
          destX, destY, destW, destH              // destination canvas rect
        );
      }
    }
  }

  // render storm overlay
  if (S.stormLoaded && processedStorm) {
    S.renderedW = offscreen.width * (S.stormScale / 100);
    S.renderedH = offscreen.height * (S.stormScale / 100);

    const radius = Math.max(S.renderedW, S.renderedH);
    if (S.stormX + radius > 0 && S.stormX - radius < W && S.stormY + radius > 0 && S.stormY - radius < H) {

      ctx.save();
      ctx.globalAlpha = S.opacity;
      ctx.globalCompositeOperation = S.blendMode;
      ctx.translate(S.stormX, S.stormY);
      ctx.rotate(S.stormRotation * Math.PI / 180);
      ctx.scale(S.flipH ? -1 : 1, S.flipV ? -1 : 1);
      ctx.drawImage(processedStorm, -S.renderedW / 2, -S.renderedH / 2, S.renderedW, S.renderedH);
      ctx.restore();
    }

    const dispW = (S.renderedW + 0.5) | 0;
    const dispH = (S.renderedH + 0.5) | 0;
    const intSX = (S.stormX + 0.5) | 0;
    const intSY = (S.stormY + 0.5) | 0;

    if (UI.numSx.value != intSX) UI.numSx.value = intSX;
    if (UI.numSy.value != intSY) UI.numSy.value = intSY;
    if (UI.numSw.value != dispW) UI.numSw.value = dispW;
    if (UI.numSh.value != dispH) UI.numSh.value = dispH;

    const transformStr = `translate(${((S.stormX - S.renderedW / 2) + 0.5) | 0}px, ${((S.stormY - S.renderedH / 2) + 0.5) | 0}px)`;
    const boxW = dispW + 'px';
    const boxH = dispH + 'px';

    if (UI.stormBox.style.display !== 'block') {
      UI.stormBox.style.display = 'block';
      UI.stormBox.style.left = '0px';
      UI.stormBox.style.top = '0px';
    }
    if (lastBoxL !== transformStr) { UI.stormBox.style.transform = transformStr; lastBoxL = transformStr; }
    if (lastBoxW !== boxW) { UI.stormBox.style.width = boxW; lastBoxW = boxW; }
    if (lastBoxH !== boxH) { UI.stormBox.style.height = boxH; lastBoxH = boxH; }
  }

  S.perfRend = performance.now() - t0;
  updatePerfUI();
}


function loop() { if (S.dirty) render(); requestAnimationFrame(loop); }
loop();

/* ──────────────────────────────────────────────────────────────
   MOUSE INTERACTION
────────────────────────────────────────────────────────────── */
function isOverStorm(mx, my) {
  if (!S.stormLoaded) return false;
  return (mx >= S.stormX - S.renderedW / 2 && mx <= S.stormX + S.renderedW / 2 &&
    my >= S.stormY - S.renderedH / 2 && my <= S.stormY + S.renderedH / 2);
}

canvas.addEventListener('mousedown', e => {
  if (!canvasRect) return;
  const mx = e.clientX - canvasRect.left;
  const my = e.clientY - canvasRect.top;
  S.dragging = true;
  S.dragStartX = mx; S.dragStartY = my;
  if (isOverStorm(mx, my) && S.stormLoaded) {
    S.dragMode = 'storm';
    S.dragStartStormX = S.stormX; S.dragStartStormY = S.stormY;
    canvas.style.cursor = 'grabbing';
  } else {
    S.dragMode = 'map';
    S.dragStartMapX = S.mapOffX; S.dragStartMapY = S.mapOffY;
    canvas.style.cursor = 'grabbing';
    markMapInteraction();
  }
});

canvas.addEventListener('mousemove', e => {
  if (!canvasRect) return;
  const mx = e.clientX - canvasRect.left;
  const my = e.clientY - canvasRect.top;

  if (S.mapLoaded) {
    const mw = mapBaseW || (fallbackCanvas ? fallbackCanvas.width : mapImg.naturalWidth);
    const mh = mapBaseH || (fallbackCanvas ? fallbackCanvas.height : mapImg.naturalHeight);
    const imgX = (mx - S.mapOffX) / S.mapZoom;
    const imgY = (my - S.mapOffY) / S.mapZoom;
    const lon = ((imgX / mw) * 360 - 180).toFixed(2);
    const lat = (90 - (imgY / mh) * 180).toFixed(2);

    // only update DOM text if it shifted
    if (lat !== lastLat || lon !== lastLon) {
      UI.hudCoords.textContent = `LAT ${lat}° · LON ${lon}°`;
      lastLat = lat; lastLon = lon;
    }
  }

  if (!S.dragging) {
    const isOver = isOverStorm(mx, my);
    canvas.style.cursor = isOver ? 'grab' : 'crosshair';
    const mode = isOver && S.stormLoaded ? 'MODE: DRAG STORM' : 'MODE: PAN MAP';

    if (mode !== lastMode) {
      UI.hudMode.textContent = mode;
      lastMode = mode;
    }
    return;
  }

  const dx = mx - S.dragStartX, dy = my - S.dragStartY;
  if (S.dragMode === 'storm') {
    S.stormX = S.dragStartStormX + dx;
    S.stormY = S.dragStartStormY + dy;
    S.dirty = true;
  } else {
    S.mapOffX = S.dragStartMapX + dx;
    S.mapOffY = S.dragStartMapY + dy;
    markMapInteraction();
    S.dirty = true;
  }
});

canvas.addEventListener('mouseup', () => { S.dragging = false; canvas.style.cursor = 'crosshair'; });
canvas.addEventListener('mouseleave', () => { S.dragging = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!canvasRect) return;

  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const mx = e.clientX - canvasRect.left;
  const my = e.clientY - canvasRect.top;

  if (S.stormLoaded && isOverStorm(mx, my)) {
    S.stormScale = Math.max(5, Math.min(200, S.stormScale * delta));
    document.getElementById('sl-scale').value = S.stormScale;
    document.getElementById('val-scale').textContent = Math.round(S.stormScale) + '%';
    updateSliderFill(document.getElementById('sl-scale'));
  } else {
    zoomMapAt(mx, my, delta);
    markMapInteraction();
  }
  S.dirty = true;
}, { passive: false });

/* ──────────────────────────────────────────────────────────────
   CONTROLS WIRING
────────────────────────────────────────────────────────────── */
function wire(id, key, transform, valId, format) {
  const el = document.getElementById(id);
  const vl = valId ? document.getElementById(valId) : null;
  el.addEventListener('input', () => {
    requestAnimationFrame(() => {
      const raw = parseFloat(el.value);
      S[key] = transform ? transform(raw) : raw;
      if (vl) vl.textContent = format ? format(S[key]) : S[key];
      updateSliderFill(el);
    });
  });
  updateSliderFill(el);
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

const debouncedProcessStorm = debounce(processStorm, 50);

function wireProc(id, key, transform, valId, format) {
  const el = document.getElementById(id);
  const vl = valId ? document.getElementById(valId) : null;
  el.addEventListener('input', () => {
    requestAnimationFrame(() => {
      const raw = parseFloat(el.value);
      S[key] = transform ? transform(raw) : raw;
      if (vl) vl.textContent = format ? format(S[key]) : S[key];
      updateSliderFill(el);

      if (S.stormLoaded) {
        debouncedProcessStorm();
      }
    });
  });
  updateSliderFill(el);
}

wire('sl-scale', 'stormScale', null, 'val-scale', v => Math.round(v) + '%');
wire('sl-rotate', 'stormRotation', null, 'val-rotate', v => Math.round(v) + '°');
wire('sl-opacity', 'opacity', v => v / 100, 'val-opacity', v => Math.round(v * 100) + '%');

wireProc('sl-alpha-thresh', 'alphaThresh', null, 'val-alpha-thresh', v => Math.round(v));
wireProc('sl-alpha-feather', 'alphaFeather', null, 'val-alpha-feather', v => Math.round(v));
wireProc('sl-lvl-min', 'levelsMin', null, 'val-lvl-min', v => Math.round(v));
wireProc('sl-lvl-gamma', 'levelsGamma', v => v / 100, 'val-lvl-gamma', v => v.toFixed(2));
wireProc('sl-lvl-max', 'levelsMax', null, 'val-lvl-max', v => Math.round(v));

document.getElementById('chk-desat').addEventListener('change', e => { S.desaturate = e.target.checked; if (S.stormLoaded) processStorm(); });
document.getElementById('chk-c2a').addEventListener('change', e => { S.c2a = e.target.checked; if (S.stormLoaded) processStorm(); });
document.getElementById('chk-cerase').addEventListener('change', e => { S.cErase = e.target.checked; if (S.stormLoaded) processStorm(); });
document.getElementById('btn-apply').addEventListener('click', () => { if (S.stormLoaded) processStorm(); });

document.getElementById('btn-reset-proc').addEventListener('click', () => {
  S.desaturate = true; S.c2a = true; S.cErase = false; S.alphaThresh = 30; S.alphaFeather = 80;
  S.levelsMin = 0; S.levelsGamma = 1.0; S.levelsMax = 255;
  ['chk-desat', 'chk-c2a'].forEach(id => document.getElementById(id).checked = true);
  document.getElementById('chk-cerase').checked = false;
  setSlider('sl-alpha-thresh', 30, 'val-alpha-thresh', '30');
  setSlider('sl-alpha-feather', 80, 'val-alpha-feather', '80');
  setSlider('sl-lvl-min', 0, 'val-lvl-min', '0');
  setSlider('sl-lvl-gamma', 100, 'val-lvl-gamma', '1.00');
  setSlider('sl-lvl-max', 255, 'val-lvl-max', '255');
  if (S.stormLoaded) processStorm();
});

document.getElementById('btn-reset-tr').addEventListener('click', () => {
  S.stormScale = 50; S.stormRotation = 0; S.opacity = 1.0; S.flipH = false; S.flipV = false;
  setSlider('sl-scale', 50, 'val-scale', '50%'); setSlider('sl-rotate', 0, 'val-rotate', '0°'); setSlider('sl-opacity', 100, 'val-opacity', '100%');
  document.getElementById('btn-flip-h').classList.remove('active');
  document.getElementById('btn-flip-v').classList.remove('active');
  S.dirty = true;
});

document.getElementById('btn-flip-h').addEventListener('click', function () { S.flipH = !S.flipH; this.classList.toggle('active', S.flipH); S.dirty = true; });
document.getElementById('btn-flip-v').addEventListener('click', function () { S.flipV = !S.flipV; this.classList.toggle('active', S.flipV); S.dirty = true; });

document.getElementById('btn-center').addEventListener('click', () => { S.stormX = W / 2; S.stormY = H / 2; S.dirty = true; });
document.getElementById('num-sx').addEventListener('input', e => { S.stormX = parseFloat(e.target.value) || 0; S.dirty = true; });
document.getElementById('num-sy').addEventListener('input', e => { S.stormY = parseFloat(e.target.value) || 0; S.dirty = true; });

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  zoomMapAt(W * 0.5, H * 0.5, 1.2);
  markMapInteraction();
  S.dirty = true;
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  zoomMapAt(W * 0.5, H * 0.5, 0.8);
  markMapInteraction();
  S.dirty = true;
});

document.querySelectorAll('[data-blend]').forEach(btn => {
  btn.addEventListener('click', function () {
    document.querySelectorAll('[data-blend]').forEach(b => b.classList.remove('active'));
    this.classList.add('active'); S.blendMode = this.dataset.blend; S.dirty = true;
  });
});

/* ──────────────────────────────────────────────────────────────
   EXPORT
────────────────────────────────────────────────────────────── */
async function getExportBlob(mime, quality) {
  const ratio = document.getElementById('sel-ratio').value;
  let targetW, targetH;

  if (ratio === 'full') {
    targetW = W; targetH = H;
  } else {
    let baseSize = S.stormLoaded ? Math.max(offscreen.width, offscreen.height) : Math.min(W, H);
    if (ratio === 'square') {
      targetW = targetH = Math.max(512, baseSize);
    } else if (ratio === '16-9') {
      targetW = Math.max(1024, baseSize);
      targetH = Math.round(targetW * 9 / 16);
    }
  }

  const scale = targetW / W;
  const offsetX = (targetW - W * scale) / 2;
  const offsetY = (targetH - H * scale) / 2;
  const scaledCenterX = offsetX + (S.stormX !== undefined ? S.stormX : W / 2) * scale;
  const scaledCenterY = offsetY + (S.stormY !== undefined ? S.stormY : H / 2) * scale;

  if (processingWorker && typeof OffscreenCanvas !== 'undefined') {
    const mapSource = fallbackCanvas || mapBitmap || mapImg;
    let exportMapBitmap = null, exportStormBitmap = null;
    
    if (S.mapLoaded && mapSource) {
      exportMapBitmap = await createImageBitmap(mapSource);
    }
    if (S.stormLoaded && processedStorm) {
      exportStormBitmap = await createImageBitmap(processedStorm);
    }

    const payload = {
      type: 'export',
      targetW, targetH, bg2: getComputedStyle(document.body).getPropertyValue('--bg2'),
      scale, offsetX, offsetY, scaledCenterX, scaledCenterY,
      mapBitmap: exportMapBitmap,
      mapW: mapBaseW || targetW, 
      mapH: mapBaseH || targetH,
      scaledMapW: (mapBaseW || targetW) * S.mapZoom * scale,
      scaledMapH: (mapBaseH || targetH) * S.mapZoom * scale,
      mapZoom: S.mapZoom, mapOffX: S.mapOffX, mapOffY: S.mapOffY,
      stormBitmap: exportStormBitmap,
      renderedW: S.renderedW, renderedH: S.renderedH,
      opacity: S.opacity, blendMode: S.blendMode,
      stormRotation: S.stormRotation, flipH: S.flipH, flipV: S.flipV,
      mime, quality
    };

    const transfers = [];
    if (exportMapBitmap) transfers.push(exportMapBitmap);
    if (exportStormBitmap) transfers.push(exportStormBitmap);

    return new Promise(resolve => {
      activeExportResolve = resolve;
      processingWorker.postMessage(payload, transfers);
    });
  } else {
    // fallback for browsers without OffscreenCanvas
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = targetW;
    exportCanvas.height = targetH;
    const ctx = exportCanvas.getContext('2d');

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg2');
    ctx.fillRect(0, 0, targetW, targetH);

    if (S.mapLoaded) {
      const mapSource = fallbackCanvas || mapImg;
      const mapW = mapBaseW || (fallbackCanvas ? fallbackCanvas.width : mapImg.naturalWidth);
      const mapH = mapBaseH || (fallbackCanvas ? fallbackCanvas.height : mapImg.naturalHeight);
      const scaledMapW = mapW * S.mapZoom * scale;
      const scaledMapH = mapH * S.mapZoom * scale;
      const mapOffsetX = offsetX + S.mapOffX * scale;
      const mapOffsetY = offsetY + S.mapOffY * scale;

      let drawX = mapOffsetX % scaledMapW;
      if (drawX > 0) drawX -= scaledMapW;

      for (; drawX < targetW; drawX += scaledMapW) {
        const destX = Math.max(0, drawX);
        const destRight = Math.min(targetW, drawX + scaledMapW);
        const destW = destRight - destX;
        if (destW > 0) {
          const srcX = (destX - drawX) / (S.mapZoom * scale);
          const srcW = destW / (S.mapZoom * scale);
          ctx.drawImage(mapSource, srcX, 0, srcW, mapH, destX, mapOffsetY, destW, scaledMapH);
        }
      }
    }

    if (S.stormLoaded && processedStorm) {
      const scaledRenderedW = S.renderedW * scale;
      const scaledRenderedH = S.renderedH * scale;
      ctx.save();
      ctx.globalAlpha = S.opacity;
      ctx.globalCompositeOperation = S.blendMode;
      ctx.translate(scaledCenterX, scaledCenterY);
      ctx.rotate(S.stormRotation * Math.PI / 180);
      ctx.scale(S.flipH ? -1 : 1, S.flipV ? -1 : 1);
      ctx.drawImage(processedStorm, -scaledRenderedW / 2, -scaledRenderedH / 2, scaledRenderedW, scaledRenderedH);
      ctx.restore();
    }

    return new Promise(resolve => exportCanvas.toBlob(resolve, mime, quality));
  }
}

async function doExport() {
  const btn = document.getElementById('btn-export');
  const ogText = btn.textContent;
  btn.textContent = "Processing...";
  btn.disabled = true;

  const fmt = document.getElementById('sel-format').value;
  const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  const quality = fmt === 'png' ? 1 : 0.92;
  
  const blob = await getExportBlob(mime, quality);
  const dataURL = URL.createObjectURL(blob);
  
  const a = document.createElement('a'); 
  a.href = dataURL; 
  a.download = `storm-composite.${fmt}`; 
  a.click();
  
  setTimeout(() => URL.revokeObjectURL(dataURL), 5000);
  
  btn.textContent = ogText;
  btn.disabled = false;
}

document.getElementById('btn-export').addEventListener('click', doExport);
document.getElementById('btn-export-download').addEventListener('click', doExport);

document.getElementById('btn-copy-canvas').addEventListener('click', async () => {
  const btn = document.getElementById('btn-copy-canvas');
  const orig = btn.textContent; 
  btn.textContent = "Copying...";
  btn.disabled = true;
  
  try {
    const blob = await getExportBlob('image/png', 1);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    btn.textContent = '✓ Copied!';
  } catch (e) {
    btn.textContent = 'Failed';
    console.warn(e);
  }
  
  setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
  }, 1500);
});

/* ──────────────────────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────────────────────── */
function setSlider(id, val, valId, display) {
  const el = document.getElementById(id); el.value = val;
  if (valId) document.getElementById(valId).textContent = display;
  updateSliderFill(el);
}

function updateSliderFill(el) {
  if (el.type !== 'range') return;
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--fill', pct + '%');
}
document.querySelectorAll('input[type=range]').forEach(updateSliderFill);

function updatePerfUI() {
  if (S.perfProc > 0) {
    document.getElementById('perf-val-proc').textContent = S.perfProc.toFixed(1) + 'ms';
    document.getElementById('perf-bar-proc').style.width = Math.min(100, S.perfProc / 2) + '%';
    document.getElementById('perf-val-rend').textContent = S.perfRend.toFixed(1) + 'ms';
    document.getElementById('perf-bar-rend').style.width = Math.min(100, S.perfRend / 2) + '%';

    const hud = document.getElementById('hud-perf');
    hud.style.display = 'block';
    hud.textContent = `PROC ${S.perfProc.toFixed(0)}ms · REND ${S.perfRend.toFixed(0)}ms`;
  }
}
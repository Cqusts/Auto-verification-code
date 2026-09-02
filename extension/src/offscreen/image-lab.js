/**
 * Canvas pre-processing for CAPTCHA images.
 *
 * Tesseract is trained on clean printed text, so the single biggest accuracy win
 * is turning a noisy 80x30 CAPTCHA into a large, high-contrast, black-on-white
 * bitmap with a quiet margin. Everything here runs locally on a canvas.
 */

const PADDING = 12;

export async function decodeImage(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function toCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Cuts the CAPTCHA out of a full-viewport screenshot.
 * `crop` is in CSS pixels plus the page's devicePixelRatio.
 */
function cropBitmap(bitmap, crop) {
  const dpr = crop.dpr || 1;
  const sx = Math.max(0, Math.round(crop.x * dpr));
  const sy = Math.max(0, Math.round(crop.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(crop.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(crop.height * dpr));
  if (sw <= 0 || sh <= 0) throw new Error('crop-out-of-bounds');
  const canvas = toCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

/** Otsu's method: the threshold that maximises between-class variance. */
function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t += 1) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Drops pixels with too few same-coloured neighbours — kills salt-and-pepper noise. */
function despeckle(data, width, height) {
  const copy = new Uint8ClampedArray(data);
  const at = (x, y) => copy[(y * width + x) * 4];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let dark = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (at(x + dx, y + dy) < 128) dark += 1;
        }
      }
      const idx = (y * width + x) * 4;
      const isDark = copy[idx] < 128;
      let value = null;
      if (isDark && dark <= 1) value = 255;
      else if (!isDark && dark >= 7) value = 0;
      if (value !== null) {
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
      }
    }
  }
}

/**
 * @param {ImageBitmap} bitmap
 * @param {object|null} crop
 * @param {object} opts  preprocess settings
 * @param {boolean} invert  force polarity flip (used for the retry variant)
 * @returns {HTMLCanvasElement}
 */
export function preprocess(bitmap, crop, opts = {}, { invert = false, binarize = null } = {}) {
  const {
    enabled = true,
    scale = 3,
    grayscale = true,
    autoInvert = true,
    binarize: binarizeOpt = true,
    threshold = 0,
    despeckle: despeckleOpt = true,
    trimBorder = 1,
  } = opts;

  const source = crop ? cropBitmap(bitmap, crop) : bitmap;
  const srcW = source.width;
  const srcH = source.height;
  if (!srcW || !srcH) throw new Error('empty-image');

  const trim = Math.max(0, Math.min(trimBorder, Math.floor(Math.min(srcW, srcH) / 4)));
  const innerW = srcW - trim * 2;
  const innerH = srcH - trim * 2;

  const factor = enabled ? Math.max(1, Math.min(scale, 8)) : 1;
  const outW = Math.round(innerW * factor);
  const outH = Math.round(innerH * factor);

  const canvas = toCanvas(outW + PADDING * 2, outH + PADDING * 2);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, trim, trim, innerW, innerH, PADDING, PADDING, outW, outH);

  if (!enabled) return canvas;

  const image = ctx.getImageData(PADDING, PADDING, outW, outH);
  const { data } = image;
  const histogram = new Uint32Array(256);
  let sum = 0;

  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma; alpha-blend against white so transparent PNGs stay readable.
    const a = data[i + 3] / 255;
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (!grayscale) lum = (r + g + b) / 3;
    const v = Math.round(lum);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
    histogram[v] += 1;
    sum += v;
  }

  const pixels = data.length / 4;
  const mean = sum / pixels;
  const shouldInvert = invert !== (autoInvert && mean < 110);

  const doBinarize = binarize === null ? binarizeOpt : binarize;
  if (doBinarize) {
    const t = threshold > 0 ? threshold : otsuThreshold(histogram, pixels);
    for (let i = 0; i < data.length; i += 4) {
      const dark = shouldInvert ? data[i] > t : data[i] <= t;
      const v = dark ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    if (despeckleOpt) despeckle(data, outW, outH);
  } else if (shouldInvert) {
    for (let i = 0; i < data.length; i += 4) {
      const v = 255 - data[i];
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }

  ctx.putImageData(image, PADDING, PADDING);
  return canvas;
}

export function canvasToDataUrl(canvas) {
  return canvas.toDataURL('image/png');
}

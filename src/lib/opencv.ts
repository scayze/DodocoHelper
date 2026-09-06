import type { CV as OpenCVCV, Mat, MatVector } from "@techstark/opencv-js";

type CV = OpenCVCV;

let cvRef: CV | null = null;
let pending: Promise<CV> | null = null;

function resolveCv(mod: unknown): CV {
  if (mod && typeof (mod as CV).Mat === "function") return mod as CV;
  throw new Error("OpenCV.js did not expose a Mat constructor");
}

/** Pull the OpenCV module value out of the various import shapes. */
function unwrapModule(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return mod;
  const m = mod as Record<string, unknown>;
  if (typeof m.Mat === "function") return mod;
  // Vite can preserve the UMD factory Promise under `default` in the browser
  // bundle. Keep the Promise so the loader can await it before resolving CV.
  if (m.default && typeof (m.default as { then?: unknown }).then === "function") return m.default;
  if (m.default && typeof (m.default as Record<string, unknown>).Mat === "function") return m.default;
  if (m["module.exports"] && typeof (m["module.exports"] as Record<string, unknown>).Mat === "function") return m["module.exports"];
  if (m["module.exports"] && typeof (m["module.exports"] as { then?: unknown }).then === "function") return m["module.exports"];
  return mod;
}

/**
 * Lazy-load OpenCV.js. Safe to call from multiple places: the first call kicks
 * off the load, subsequent calls return the same promise / instance. In the
 * browser, `@techstark/opencv-js` is a UMD bundle that attaches `cv` to
 * globalThis once its WASM has initialised. In Node (used by the test
 * harness) the package exports a Promise that resolves to the same namespace.
 */
export function loadOpenCV(): Promise<CV> {
  if (cvRef) return Promise.resolve(cvRef);
  if (pending) return pending;
  pending = (async (): Promise<CV> => {
    const mod = await import("@techstark/opencv-js");
    let value: unknown = mod;
    // The package is published as UMD/CommonJS but is consumed through ESM by
    // Vite and Node. Walk the wrapper layers until the actual CV namespace is
    // reached, awaiting each factory Promise along the way.
    for (let i = 0; i < 4; i++) {
      const unwrapped = unwrapModule(value);
      if (unwrapped !== value) value = unwrapped;
      if (value && typeof (value as { then?: unknown }).then === "function") {
        value = await (value as Promise<unknown>);
        continue;
      }
      break;
    }
    const cv = resolveCv(unwrapModule(value));
    cvRef = cv;
    return cv;
  })();
  return pending;
}

export function getOpenCV(): CV {
  if (!cvRef) throw new Error("OpenCV.js not loaded yet — call loadOpenCV() first");
  return cvRef;
}

// ---------------------------------------------------------------------------
// Constants not exposed in @techstark/opencv-js's .d.ts but present at runtime.
// (The package's TypeScript types omit the KmeansFlags enum and TermCriteria
// composite flag; values mirror OpenCV 4.5 headers.)
// ---------------------------------------------------------------------------

export const KMEANS_RANDOM_CENTERS = 0;
export const KMEANS_PP_CENTERS = 2;
export const TERM_CRITERIA_EPS = 2;
export const TERM_CRITERIA_MAX_ITER = 1;
export const RETR_LIST = 1;
export const CC_STAT_LEFT = 0;
export const CC_STAT_TOP = 1;
export const CC_STAT_WIDTH = 2;
export const CC_STAT_HEIGHT = 3;
export const CC_STAT_AREA = 4;

// ---------------------------------------------------------------------------
// Small typed helpers that keep Mat lifetimes obvious.
// ---------------------------------------------------------------------------

/** Push a BGR 8UC3 Mat into the heap. */
export function newMatFromBGR(data: Uint8ClampedArray, w: number, h: number): Mat {
  const cv = getOpenCV();
  const src = cv.matFromImageData({
    data: new Uint8ClampedArray(data),
    width: w,
    height: h,
    colorSpace: "srgb",
  } as unknown as ImageData);
  const bgr = new cv.Mat();
  cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
  src.delete();
  return bgr;
}

/** Read BGR pixels out of a Mat into a plain Uint8ClampedArray (RGBA order). */
export function matToRGBA(mat: Mat): { data: Uint8ClampedArray; w: number; h: number } {
  const cv = getOpenCV();
  if (mat.type() === cv.CV_8UC3) {
    const rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
    const out = { data: new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), w: rgba.cols, h: rgba.rows };
    rgba.delete();
    return out;
  }
  if (mat.type() === cv.CV_8UC4) {
    return { data: new Uint8ClampedArray(mat.data.buffer, mat.data.byteOffset, mat.data.byteLength), w: mat.cols, h: mat.rows };
  }
  if (mat.type() === cv.CV_8UC1) {
    const rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    const out = { data: new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), w: rgba.cols, h: rgba.rows };
    rgba.delete();
    return out;
  }
  throw new Error(`unsupported Mat type ${mat.type()} for readback`);
}

/** Try-execute a function; delete any Mats it returns, even on throw. */
export function withMat<T extends Mat | MatVector | MatVector[] | null>(
  factory: () => T,
  fn: (m: T) => void,
): void {
  const m = factory();
  try {
    fn(m);
  } finally {
    deleteMatDeep(m);
  }
}

export function deleteMatDeep(m: Mat | MatVector | MatVector[] | null | undefined): void {
  if (!m) return;
  if (Array.isArray(m)) {
    for (const v of m) deleteMatDeep(v);
    return;
  }
  if (typeof (m as MatVector).size === "function" && typeof (m as MatVector).get === "function") {
    const v = m as MatVector;
    for (let i = 0; i < v.size(); i++) {
      const sub = v.get(i);
      if (sub) sub.delete();
    }
    v.delete();
    return;
  }
  if (typeof (m as Mat).delete === "function") {
    try {
      (m as Mat).delete();
    } catch {
      // already deleted
    }
  }
}

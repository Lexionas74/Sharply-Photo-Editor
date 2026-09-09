// Real per-pixel implementations of the Develop panel's sliders, replacing
// the previous approach of approximating them with a single CSS `filter`
// string (brightness/contrast/saturate/sepia/hue-rotate/blur). CSS filters
// are fast but each one is a blunt, global operation — "Shadows" and
// "Highlights" for instance had no way to act on only dark or only bright
// tones, and "Temperature" was approximated with sepia+hue-rotate, which
// shifts color in a very different way than a real white-balance scale does.
//
// Everything here operates on a plain `ImageData`-shaped buffer (a flat
// RGBA Uint8ClampedArray + width/height), so it has no DOM/canvas
// dependency and can run in a Web Worker — or be unit tested directly with
// plain Node, which is how this was actually verified before wiring it in.
//
// This runs on the already-decoded, already color-managed preview PNG (the
// per-camera-profile RAW render happens once, in Rust); it is a display-space
// adjustment layer on top of that, the same way Lightroom's Basic panel
// sliders are a fast, interactive layer over the underlying RAW render.

export type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  texture: number
  clarity: number
  dehaze: number
  vibrance: number
  saturation: number
  sharpening: number
  noiseReduction: number
  vignette: number
}

export const initialAdjustments: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, texture: 0, clarity: 0, dehaze: 0, vibrance: 0,
  saturation: 0, sharpening: 0, noiseReduction: 0, vignette: 0,
}

export function isNeutral(adjustments: Adjustments): boolean {
  return Object.values(adjustments).every((value) => value === 0)
}

// A minimal ImageData-like shape, so this module has no lib.dom dependency
// and the same code can run against a real ImageData or a plain test object.
export type PixelBuffer = { data: Uint8ClampedArray; width: number; height: number }

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

// Exact sRGB transfer functions (same formulas as the Rust decoder's
// `linear_to_gamma`), used so "Exposure" scales light the way a camera stop
// actually does — in linear light — rather than scaling the gamma-encoded
// byte values directly, which would make each stop look wrong relative to
// the last.
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}
function linearToSrgb(value: number): number {
  const value_ = value <= 0.0 ? 0 : value
  return value_ <= 0.0031308 ? value_ * 12.92 : 1.055 * Math.pow(value_, 1 / 2.4) - 0.055
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

// The same symmetric sigmoid S-curve used for RAW contrast in the Rust
// decoder (see `tone_curve` in lib.rs) — endpoints anchored at 0/1 and the
// midpoint held exactly at 0.5, so contrast doesn't drift overall exposure.
function toneCurve(value: number, k: number, lo: number, hi: number): number {
  if (Math.abs(hi - lo) < 1e-5) return clamp01(value)
  const sigmoid = (v: number) => 1 / (1 + Math.exp(-k * (v - 0.5)))
  return clamp01((sigmoid(Math.max(-0.2, Math.min(1.2, value))) - lo) / (hi - lo))
}
function toneCurveParams(strength: number): [number, number, number] {
  // Unlike the Rust RAW decoder (which always wants *some* baseline curve,
  // since it has no "neutral" state to preserve), this is a layer on top of
  // an already fully-rendered image: `strength = 0` must be an exact
  // identity, not a mild S-curve, or "Contrast: 0" would silently still be
  // changing the image. `k = 0` makes the sigmoid degenerate (see the
  // `toneCurve` guard below), which is why there's no `Math.max(...)` floor
  // here the way the Rust version has — that floor would prevent negative
  // contrast from ever flattening the curve below identity.
  const k = strength * 3.4
  const sigmoid = (v: number) => 1 / (1 + Math.exp(-k * (v - 0.5)))
  return [k, sigmoid(0), sigmoid(1)]
}

// Basic-panel tonal and color adjustments: white balance, exposure,
// highlights/shadows (luminance-masked, unlike the old global brightness
// tweak), whites/blacks (endpoint remapping), contrast, then vibrance and
// saturation. All of this is a single pass over the pixels for efficiency.
export function applyToneAndColor(buffer: PixelBuffer, adjustments: Adjustments): void {
  const { data, width, height } = buffer
  const {
    exposure, contrast, highlights, shadows, whites, blacks,
    temperature, tint, vibrance, saturation,
  } = adjustments

  const exposureFactor = Math.pow(2, (exposure / 100) * 2)
  const rTemp = 1 + (temperature / 100) * 0.3
  const bTemp = 1 - (temperature / 100) * 0.3
  const gTint = 1 - (tint / 100) * 0.25
  const blackPoint = -(blacks / 100) * 0.15
  const whitePoint = 1 - (whites / 100) * 0.15
  const whiteBlackRange = Math.max(0.05, whitePoint - blackPoint)
  const [curveK, curveLo, curveHi] = toneCurveParams(contrast / 100)
  const highlightAmount = (highlights / 100) * 0.5
  const shadowAmount = (shadows / 100) * 0.5
  const vibranceAmount = (vibrance / 100) * 0.8
  const saturationAmount = 1 + (saturation / 100) * 0.8

  const pixelCount = width * height
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4
    let r = data[offset] / 255
    let g = data[offset + 1] / 255
    let b = data[offset + 2] / 255

    // White balance: a simple multiplicative tilt on the warm/cool and
    // green/magenta axes, applied before exposure so it behaves like a
    // scene white-balance shift rather than a display-time color cast.
    r *= rTemp
    b *= bTemp
    g *= gTint

    // Exposure, in linear light so each "stop" doubles/halves actual light
    // rather than the gamma-encoded byte value.
    r = linearToSrgb(srgbToLinear(clamp01(r)) * exposureFactor)
    g = linearToSrgb(srgbToLinear(clamp01(g)) * exposureFactor)
    b = linearToSrgb(srgbToLinear(clamp01(b)) * exposureFactor)

    // Highlights/Shadows: luminance-masked brightness shifts, so — unlike a
    // flat brightness tweak — "Shadows" only lifts dark tones and leaves
    // bright ones alone, and vice versa for "Highlights".
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const highlightMask = smoothstep(0.45, 1.0, luma)
    const shadowMask = 1 - smoothstep(0.0, 0.55, luma)
    const toneShift = highlightAmount * highlightMask + shadowAmount * shadowMask
    r += toneShift
    g += toneShift
    b += toneShift

    // Whites/Blacks: remap the black/white clipping points, like dragging
    // the endpoint sliders on a levels/curves panel, instead of a further
    // brightness/contrast nudge.
    r = clamp01((r - blackPoint) / whiteBlackRange)
    g = clamp01((g - blackPoint) / whiteBlackRange)
    b = clamp01((b - blackPoint) / whiteBlackRange)

    // Contrast: the same anchored S-curve used for RAW tone-mapping.
    r = toneCurve(r, curveK, curveLo, curveHi)
    g = toneCurve(g, curveK, curveLo, curveHi)
    b = toneCurve(b, curveK, curveLo, curveHi)

    // Vibrance protects already-saturated colors and skin tones by scaling
    // less as a pixel's existing chroma goes up; Saturation scales every
    // pixel by the same amount regardless of how saturated it already is —
    // this is the actual distinction Lightroom draws between the two.
    const finalLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    const vibranceScale = 1 + vibranceAmount * (1 - chroma)
    r = finalLuma + (r - finalLuma) * vibranceScale
    g = finalLuma + (g - finalLuma) * vibranceScale
    b = finalLuma + (b - finalLuma) * vibranceScale
    const vibratedLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    r = vibratedLuma + (r - vibratedLuma) * saturationAmount
    g = vibratedLuma + (g - vibratedLuma) * saturationAmount
    b = vibratedLuma + (b - vibratedLuma) * saturationAmount

    data[offset] = clamp01(r) * 255
    data[offset + 1] = clamp01(g) * 255
    data[offset + 2] = clamp01(b) * 255
  }
}

// A separable box blur with a sliding-window sum, so cost is O(width *
// height) regardless of radius rather than O(width * height * radius) —
// this is what keeps Texture/Clarity/Dehaze/Sharpening/Noise Reduction
// (each of which needs a blur under the hood) fast enough to stay
// interactive on a multi-megapixel preview.
function boxBlur(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return source.slice()
  const temp = new Float32Array(source.length)
  const output = new Float32Array(source.length)
  const windowSize = radius * 2 + 1

  // Horizontal pass.
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x += 1) {
      const clampedX = Math.min(width - 1, Math.max(0, x))
      sum += source[rowStart + clampedX]
    }
    for (let x = 0; x < width; x += 1) {
      temp[rowStart + x] = sum / windowSize
      const addX = Math.min(width - 1, x + radius + 1)
      const subX = Math.max(0, x - radius)
      sum += source[rowStart + addX] - source[rowStart + subX]
    }
  }

  // Vertical pass.
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -radius; y <= radius; y += 1) {
      const clampedY = Math.min(height - 1, Math.max(0, y))
      sum += temp[clampedY * width + x]
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / windowSize
      const addY = Math.min(height - 1, y + radius + 1)
      const subY = Math.max(0, y - radius)
      sum += temp[addY * width + x] - temp[subY * width + x]
    }
  }
  return output
}

// Shared "local contrast" building block behind Texture, Clarity, and
// Dehaze: each is an unsharp mask (boost the difference between the image
// and a blurred copy of itself), differing mainly in the blur radius —
// Texture reacts to fine detail (small radius), Clarity to broader
// mid-frequency structure (medium radius), and Dehaze to the largest,
// haze-like low-frequency variation (biggest radius). The delta is added
// equally to every channel rather than only to luminance, which is a
// simplification — a from-scratch implementation of Lightroom's actual
// luminance-only local contrast would need a persistent luma/chroma
// separation, out of scope for this pass — but it stays visually close for
// the moderate amounts these sliders are typically pushed to.
function applyLocalContrast(buffer: PixelBuffer, radiusPx: number, amount: number): void {
  if (amount === 0) return
  const { data, width, height } = buffer
  const pixelCount = width * height
  const luma = new Float32Array(pixelCount)
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4
    luma[i] = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]
  }
  const blurred = boxBlur(luma, width, height, Math.max(1, Math.round(radiusPx)))
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4
    const delta = (luma[i] - blurred[i]) * amount
    data[offset] = data[offset] + delta
    data[offset + 1] = data[offset + 1] + delta
    data[offset + 2] = data[offset + 2] + delta
  }
}

function applyDehaze(buffer: PixelBuffer, dehaze: number): void {
  if (dehaze === 0) return
  const radius = Math.max(8, Math.round(Math.min(buffer.width, buffer.height) * 0.04))
  applyLocalContrast(buffer, radius, (dehaze / 100) * 0.6)
  // Dehaze also characteristically deepens blacks slightly and lifts
  // saturation a touch, which a plain local-contrast boost alone doesn't
  // capture.
  const crush = Math.max(0, dehaze / 100) * 0.05
  const satBoost = 1 + Math.max(0, dehaze / 100) * 0.15
  const { data, width, height } = buffer
  const pixelCount = width * height
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4
    let r = data[offset] / 255
    let g = data[offset + 1] / 255
    let b = data[offset + 2] / 255
    if (crush > 0) {
      r = clamp01((r - crush) / (1 - crush))
      g = clamp01((g - crush) / (1 - crush))
      b = clamp01((b - crush) / (1 - crush))
    }
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    r = luma + (r - luma) * satBoost
    g = luma + (g - luma) * satBoost
    b = luma + (b - luma) * satBoost
    data[offset] = clamp01(r) * 255
    data[offset + 1] = clamp01(g) * 255
    data[offset + 2] = clamp01(b) * 255
  }
}

// Standard unsharp masking: subtract a blurred copy from the original and
// add the (scaled) difference back on top, which is what real sharpening
// tools do — not a CSS contrast bump.
function applySharpening(buffer: PixelBuffer, sharpening: number): void {
  if (sharpening <= 0) return
  applyLocalContrast(buffer, 1, (sharpening / 100) * 0.8)
}

// Noise reduction as a blend toward a blurred copy of the image — a real
// (if simple) smoothing operation, rather than the old CSS `blur()`, which
// blurred the whole displayed image uniformly with no "amount" control
// beyond that one radius.
function applyNoiseReduction(buffer: PixelBuffer, noiseReduction: number): void {
  if (noiseReduction <= 0) return
  const { data, width, height } = buffer
  const pixelCount = width * height
  const radius = 1 + Math.round((noiseReduction / 100) * 3)
  const mix = (noiseReduction / 100) * 0.6
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Float32Array(pixelCount)
    for (let i = 0; i < pixelCount; i += 1) plane[i] = data[i * 4 + channel]
    const blurred = boxBlur(plane, width, height, radius)
    for (let i = 0; i < pixelCount; i += 1) {
      data[i * 4 + channel] = plane[i] * (1 - mix) + blurred[i] * mix
    }
  }
}

function applyVignette(buffer: PixelBuffer, vignette: number): void {
  if (vignette <= 0) return
  const { data, width, height } = buffer
  const centerX = width / 2
  const centerY = height / 2
  const maxDist = Math.sqrt(centerX * centerX + centerY * centerY)
  const strength = (vignette / 100) * 0.7
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX
      const dy = y - centerY
      const dist = Math.sqrt(dx * dx + dy * dy) / maxDist
      const falloff = smoothstep(0.4, 1.1, dist)
      const factor = 1 - falloff * strength
      const offset = (y * width + x) * 4
      data[offset] *= factor
      data[offset + 1] *= factor
      data[offset + 2] *= factor
    }
  }
}

// Entry point: runs every enabled adjustment, in roughly the same order
// Lightroom's own pipeline applies them (white balance and tone first,
// then presence/local contrast, then detail, then effects). Passes whose
// slider is at its neutral value are skipped entirely rather than run with
// a zero amount, so leaving most sliders untouched costs nothing extra.
export function processImage(buffer: PixelBuffer, adjustments: Adjustments): void {
  if (isNeutral(adjustments)) return
  applyToneAndColor(buffer, adjustments)
  if (adjustments.texture !== 0) {
    applyLocalContrast(buffer, 2, (adjustments.texture / 100) * 0.5)
  }
  if (adjustments.clarity !== 0) {
    const radius = Math.max(4, Math.round(Math.min(buffer.width, buffer.height) * 0.012))
    applyLocalContrast(buffer, radius, (adjustments.clarity / 100) * 0.45)
  }
  applyDehaze(buffer, adjustments.dehaze)
  applySharpening(buffer, adjustments.sharpening)
  applyNoiseReduction(buffer, adjustments.noiseReduction)
  applyVignette(buffer, adjustments.vignette)
}

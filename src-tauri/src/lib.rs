use image::{codecs::png::PngEncoder, imageops::FilterType, ColorType, ImageEncoder};
use rawler::{decoders::RawDecodeParams, rawimage::RawImageData, rawsource::RawSource};
use serde::Serialize;

const PREVIEW_EDGE: usize = 2400;

// Tauri's IPC serializes command return values as JSON, and serde has no
// native binary type — a `Vec<u8>` field serializes as a JSON array of
// numbers, one array element per byte. For a multi-megabyte PNG preview that
// is a very large, slow payload. Base64-encoding it into a single string is
// dramatically smaller to transmit and parse; the frontend decodes it with
// `atob`.
const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
  let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
  for chunk in bytes.chunks(3) {
    let b0 = chunk[0];
    let b1 = *chunk.get(1).unwrap_or(&0);
    let b2 = *chunk.get(2).unwrap_or(&0);
    let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
    out.push(BASE64_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
    out.push(BASE64_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
    out.push(if chunk.len() > 1 { BASE64_ALPHABET[((n >> 6) & 0x3F) as usize] as char } else { '=' });
    out.push(if chunk.len() > 2 { BASE64_ALPHABET[(n & 0x3F) as usize] as char } else { '=' });
  }
  out
}

#[derive(Serialize)]
struct RawDecodeResult {
  png: String,
  camera_make: String,
  camera_model: String,
  profile: String,
}

#[derive(Clone, Copy)]
struct CameraProfile {
  name: &'static str,
  // The embedded camera matrix and as-shot white balance remain the primary
  // source of colour calibration; these are the per-camera "look" applied on
  // top, similar to Lightroom's Camera Color profiles (which are noticeably
  // punchier than a flat linear render).
  rgb_balance: [f32; 3],
  saturation: f32,
  // Multiplies the steepness of the base tone curve (see `tone_curve`) —
  // this is not a flat linear contrast stretch.
  contrast: f32,
}

fn camera_profile(requested: Option<&str>, camera_make: &str) -> CameraProfile {
  let requested = requested.unwrap_or("auto").to_ascii_lowercase();
  let make = if requested == "auto" { camera_make.to_ascii_lowercase() } else { requested };
  if make.contains("canon") {
    CameraProfile { name: "Canon Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.12, contrast: 1.12 }
  } else if make.contains("nikon") {
    CameraProfile { name: "Nikon Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.06, contrast: 1.05 }
  } else if make.contains("sony") {
    CameraProfile { name: "Sony Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.09, contrast: 1.08 }
  } else {
    CameraProfile { name: "Camera Embedded", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.02, contrast: 1.0 }
  }
}

fn linear_to_gamma(value: f32) -> f32 {
  let value = value.max(0.0);
  if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 }
}

fn to_u8(value: f32) -> u8 {
  (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn tone_curve_params(steepness: f32) -> (f32, f32, f32) {
  let k = 3.4 * steepness.max(0.05);
  let sigmoid = |v: f32| 1.0 / (1.0 + (-k * (v - 0.5)).exp());
  (k, sigmoid(0.0), sigmoid(1.0))
}

#[inline]
fn tone_curve(value: f32, k: f32, lo: f32, hi: f32) -> f32 {
  // A gentle, symmetric S-curve applied in gamma-encoded (perceptual) space.
  // This is what actually gives Lightroom's default render its contrast and
  // deep blacks. The previous approach applied `(value - 0.5) * contrast` in
  // *linear light*, where a correctly exposed midtone sits closer to 0.15-0.3,
  // nowhere near the 0.5 pivot — so the contrast term was nearly inert and
  // the image looked flat regardless of the `contrast` value. Working in
  // gamma space keeps the curve's midpoint where midtones actually live.
  //
  // `k`, `lo` and `hi` only depend on the camera profile's steepness, not on
  // the pixel — they're computed once per image by `tone_curve_params`
  // rather than recomputed (with two extra `exp()` calls) for every pixel.
  if (hi - lo).abs() < 1e-5 {
    return value.clamp(0.0, 1.0);
  }
  // Clamping the input to a little past [0, 1] rather than hard-clipping
  // beforehand gives a soft shoulder into the highlights instead of a harsh
  // cutoff, similar to the highlight rolloff a raw converter's tone curve
  // provides.
  let sigmoid = |v: f32| 1.0 / (1.0 + (-k * (v - 0.5)).exp());
  ((sigmoid(value.clamp(-0.2, 1.2)) - lo) / (hi - lo)).clamp(0.0, 1.0)
}

fn decode_embedded_preview(source: &RawSource, requested_profile: Option<String>, decode_error: impl std::fmt::Display) -> Result<RawDecodeResult, String> {
  let decoder = rawler::get_decoder(source).map_err(|error| format!("RAW decode failed: {decode_error}; preview lookup failed: {error}"))?;
  let metadata = decoder.raw_metadata(source, &RawDecodeParams::default()).ok();
  let preview = decoder
    .preview_image(source, &RawDecodeParams::default())
    .map_err(|error| format!("RAW decode failed: {decode_error}; embedded preview failed: {error}"))?
    .ok_or_else(|| format!("RAW decode failed: {decode_error}; this file has no embedded preview"))?;
  let scale = (PREVIEW_EDGE as f32 / preview.width().max(preview.height()) as f32).min(1.0);
  let preview = if scale < 1.0 {
    preview.resize((preview.width() as f32 * scale).round() as u32, (preview.height() as f32 * scale).round() as u32, FilterType::Triangle)
  } else { preview };
  let preview = preview.to_rgb8();
  let camera_make = metadata.as_ref().map(|data| data.make.as_str()).unwrap_or("Camera");
  let camera_model = metadata.as_ref().map(|data| data.model.as_str()).unwrap_or("Embedded preview");
  let profile = camera_profile(requested_profile.as_deref(), camera_make);
  let mut png = Vec::new();
  PngEncoder::new(&mut png)
    .write_image(preview.as_raw(), preview.width(), preview.height(), ColorType::Rgb8.into())
    .map_err(|error| format!("RAW preview encoding failed: {error}"))?;
  Ok(RawDecodeResult { png: base64_encode(&png), camera_make: camera_make.to_string(), camera_model: camera_model.to_string(), profile: format!("{} (embedded preview)", profile.name) })
}

#[tauri::command]
fn decode_raw(bytes: Vec<u8>, profile: Option<String>) -> Result<RawDecodeResult, String> {
  let source = RawSource::new_from_slice(&bytes);
  let raw = match rawler::decode(&source, &RawDecodeParams::default()) {
    Ok(raw) => raw,
    Err(error) => return decode_embedded_preview(&source, profile, error),
  };

  if raw.cpp != 1 {
    return decode_embedded_preview(&source, profile, "this RAW layout is not a Bayer mosaic");
  }

  let pixels = match &raw.data {
    RawImageData::Integer(values) => values,
    RawImageData::Float(_) => return Err("Floating-point RAW previews are not supported yet".to_string()),
  };
  let width = raw.width;
  let height = raw.height;
  let scale = (PREVIEW_EDGE as f32 / width.max(height) as f32).min(1.0);
  let output_width = ((width as f32 * scale).round() as usize).max(1);
  let output_height = ((height as f32 * scale).round() as usize).max(1);
  let white_levels = raw.whitelevel.as_bayer_array();
  let black_levels = raw.blacklevel.as_bayer_array();
  let wb = raw.wb_coeffs;
  let green_wb = if wb[1].is_finite() && wb[1] > 0.0 { wb[1] } else { 1.0 };
  let white_balance = [
    if wb[0].is_finite() && wb[0] > 0.0 { wb[0] / green_wb } else { 1.0 },
    1.0,
    if wb[2].is_finite() && wb[2] > 0.0 { wb[2] / green_wb } else { 1.0 },
    1.0,
  ];
  let profile = camera_profile(profile.as_deref(), &raw.clean_make);
  let camera_to_xyz = raw.cam_to_xyz_normalized();
  let mut linear_rgb = vec![[0.0_f32; 3]; output_width * output_height];
  let mut linear_peak = 0.0_f32;

  for output_y in 0..output_height {
    for output_x in 0..output_width {
      // Sample at pixel centres.  A single 3x3 neighbourhood builds all four
      // Bayer planes at once, rather than scanning the mosaic once per colour.
      let y = (((output_y as f32 + 0.5) / scale) - 0.5).round().clamp(0.0, (height - 1) as f32) as usize;
      let x = (((output_x as f32 + 0.5) / scale) - 0.5).round().clamp(0.0, (width - 1) as f32) as usize;
      let output = output_y * output_width + output_x;
      let mut sums = [0.0_f32; 4];
      let mut counts = [0_u32; 4];
      for dy in -1..=1 {
        for dx in -1..=1 {
          let sample_y = y as isize + dy;
          let sample_x = x as isize + dx;
          if sample_y < 0 || sample_x < 0 || sample_y >= height as isize || sample_x >= width as isize { continue; }
          let sample_y = sample_y as usize;
          let sample_x = sample_x as usize;
          let plane = raw.camera.cfa.color_at(sample_y, sample_x);
          if plane > 3 { continue; }
          let black = black_levels[plane];
          let white = white_levels[plane].max(black + 1.0);
          let value = pixels[sample_y * width + sample_x] as f32;
          sums[plane] += ((value - black) / (white - black)).clamp(0.0, 1.0);
          counts[plane] += 1;
        }
      }
      let mut camera_rgb = [0.0_f32; 4];
      // Bayer CFA uses R=0, G=1 and B=2.  The fourth component expected by
      // four-channel camera matrices is the second green sample, not CFA 3
      // (which denotes cyan in this decoder).  Feeding cyan/zero here was the
      // source of the magenta cast.
      for plane in 0..3 {
        camera_rgb[plane] = if counts[plane] == 0 { 0.0 } else { sums[plane] / counts[plane] as f32 } * white_balance[plane];
      }
      camera_rgb[3] = camera_rgb[1];

      let xyz = [
        camera_to_xyz[0][0] * camera_rgb[0] + camera_to_xyz[0][1] * camera_rgb[1] + camera_to_xyz[0][2] * camera_rgb[2] + camera_to_xyz[0][3] * camera_rgb[3],
        camera_to_xyz[1][0] * camera_rgb[0] + camera_to_xyz[1][1] * camera_rgb[1] + camera_to_xyz[1][2] * camera_rgb[2] + camera_to_xyz[1][3] * camera_rgb[3],
        camera_to_xyz[2][0] * camera_rgb[0] + camera_to_xyz[2][1] * camera_rgb[1] + camera_to_xyz[2][2] * camera_rgb[2] + camera_to_xyz[2][3] * camera_rgb[3],
      ];
      // rawler's camera-to-XYZ matrix follows the DNG ColorMatrix convention,
      // whose PCS is CIE XYZ referenced to a D50 white point (same convention
      // ICC profiles use) — not D65. The previous matrix here was the plain
      // XYZ(D65)->sRGB matrix, so every colour was going through an implicit,
      // un-adapted D50->D65 shift with no compensation: a Bradford-adapted
      // D50->sRGB matrix is needed instead, otherwise everything reads muted
      // and slightly off compared to a converter (like Lightroom) that
      // handles the white point correctly.
      let matrix_srgb = [
        3.1338561 * xyz[0] - 1.6168667 * xyz[1] - 0.4906146 * xyz[2],
        -0.9787684 * xyz[0] + 1.9161415 * xyz[1] + 0.0334540 * xyz[2],
        0.0719453 * xyz[0] - 0.2289914 * xyz[1] + 1.4052427 * xyz[2],
      ];
      // Some camera entries provide an incomplete colour matrix.  Do not let
      // that turn a usable RAW into a black preview: retain the as-shot,
      // white-balanced sensor RGB until a valid camera transform is available.
      let matrix_peak = matrix_srgb.iter().copied().fold(0.0_f32, f32::max);
      let matrix_sum = matrix_srgb.iter().copied().filter(|value| value.is_finite() && *value > 0.0).sum::<f32>();
      let srgb = if matrix_peak.is_finite() && matrix_peak > 0.02 && matrix_sum > 0.01 {
        matrix_srgb
      } else {
        [camera_rgb[0], (camera_rgb[1] + camera_rgb[3]) * 0.5, camera_rgb[2]]
      };
      let clean = [
        (srgb[0] * profile.rgb_balance[0]).max(0.0),
        (srgb[1] * profile.rgb_balance[1]).max(0.0),
        (srgb[2] * profile.rgb_balance[2]).max(0.0),
      ];
      linear_rgb[output] = clean;
      linear_peak = linear_peak.max(clean[0].max(clean[1]).max(clean[2]));
    }
  }

  // A percentile-derived exposure is stable across small clipped highlights,
  // unlike the previous single-pixel peak normalisation.
  let mut histogram = [0_u32; 256];
  for pixel in &linear_rgb {
    let luminance = (0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]).clamp(0.0, 2.0);
    histogram[((luminance * 127.5).round() as usize).min(255)] += 1;
  }
  let target = (linear_rgb.len() as f32 * 0.98) as u32;
  let mut cumulative = 0_u32;
  let mut percentile = 1.0_f32;
  for (bin, count) in histogram.iter().enumerate() {
    cumulative += count;
    if cumulative >= target { percentile = (bin as f32 / 127.5).max(0.01); break; }
  }
  let exposure_gain = (0.88 / percentile).clamp(0.25, 4.0);
  let (curve_k, curve_lo, curve_hi) = tone_curve_params(profile.contrast);
  let mut rgb = vec![0_u8; output_width * output_height * 3];
  for (index, pixel) in linear_rgb.into_iter().enumerate() {
    // Move into gamma-encoded (perceptual) space *before* saturation and
    // contrast, matching how a raw converter's base curve behaves — see
    // `tone_curve` for why this is the fix for the flat/dull look.
    let gamma = [
      linear_to_gamma(pixel[0] * exposure_gain),
      linear_to_gamma(pixel[1] * exposure_gain),
      linear_to_gamma(pixel[2] * exposure_gain),
    ];
    let luma = 0.2126 * gamma[0] + 0.7152 * gamma[1] + 0.0722 * gamma[2];
    for channel in 0..3 {
      let saturated = luma + (gamma[channel] - luma) * profile.saturation;
      let curved = tone_curve(saturated, curve_k, curve_lo, curve_hi);
      rgb[index * 3 + channel] = to_u8(curved);
    }
  }

  let mut png = Vec::new();
  PngEncoder::new(&mut png)
    .write_image(&rgb, output_width as u32, output_height as u32, ColorType::Rgb8.into())
    .map_err(|error| format!("RAW preview encoding failed: {error}"))?;
  Ok(RawDecodeResult { png: base64_encode(&png), camera_make: raw.clean_make, camera_model: raw.clean_model, profile: profile.name.to_string() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![decode_raw])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::decode_raw;

  // Only needed to verify `base64_encode`'s output in tests; the app never
  // needs to decode base64 on the Rust side (the frontend does that).
  fn base64_decode(input: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u32> {
      match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
      }
    }
    let mut out = Vec::new();
    let bytes: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    for chunk in bytes.chunks(4) {
      let vals: Vec<u32> = chunk.iter().filter_map(|b| val(*b)).collect();
      let mut n = 0u32;
      for v in &vals {
        n = (n << 6) | v;
      }
      n <<= 6 * (4 - chunk.len());
      let out_bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
      out.extend_from_slice(&out_bytes[..chunk.len() - 1]);
    }
    out
  }

  #[test]
  fn base64_round_trips() {
    let samples: &[&[u8]] = &[b"", b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", b"\x89PNG\r\n\x1a\n"];
    for sample in samples {
      let encoded = super::base64_encode(sample);
      assert_eq!(base64_decode(&encoded), *sample, "roundtrip mismatch for {sample:?}");
    }
    // RFC 4648 section 10 test vector, spelled out explicitly.
    assert_eq!(super::base64_encode(b"foobar"), "Zm9vYmFy");
  }

  #[test]
  fn supplied_camera_fixtures_decode_to_png() {
    let fixtures: &[&[u8]] = &[
      include_bytes!("../../RAW IMAGES/canon/1.CR3"),
      include_bytes!("../../RAW IMAGES/canon/2.CR3"),
      include_bytes!("../../RAW IMAGES/canon/3.CR3"),
      include_bytes!("../../RAW IMAGES/nikon/DSC_1683.NEF"),
      include_bytes!("../../RAW IMAGES/sony/ANT00569.ARW"),
    ];
    for fixture in fixtures {
      let result = decode_raw(fixture.to_vec(), None).expect("Camera fixture should decode");
      let png = base64_decode(&result.png);
      assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
      assert!(png.len() > 1024);
      let rendered = image::load_from_memory(&png).expect("preview PNG should be readable").to_rgb8();
      assert!(rendered.pixels().any(|pixel| pixel.0.iter().any(|value| *value > 8)), "preview should not be black");
    }
  }
}

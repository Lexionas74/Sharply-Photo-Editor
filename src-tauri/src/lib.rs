use image::{codecs::png::PngEncoder, imageops::FilterType, ColorType, ImageEncoder};
use rawler::{decoders::RawDecodeParams, rawimage::RawImageData, rawsource::RawSource};
use serde::Serialize;

const PREVIEW_EDGE: usize = 2400;

#[derive(Serialize)]
struct RawDecodeResult {
  png: Vec<u8>,
  camera_make: String,
  camera_model: String,
  profile: String,
}

#[derive(Clone, Copy)]
struct CameraProfile {
  name: &'static str,
  // These are deliberately small corrections.  The embedded camera matrix and
  // as-shot white balance remain the primary source of colour calibration.
  rgb_balance: [f32; 3],
  saturation: f32,
  contrast: f32,
}

fn camera_profile(requested: Option<&str>, camera_make: &str) -> CameraProfile {
  let requested = requested.unwrap_or("auto").to_ascii_lowercase();
  let make = if requested == "auto" { camera_make.to_ascii_lowercase() } else { requested };
  if make.contains("canon") {
    CameraProfile { name: "Canon Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.03, contrast: 1.02 }
  } else if make.contains("nikon") {
    CameraProfile { name: "Nikon Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.01, contrast: 1.01 }
  } else if make.contains("sony") {
    CameraProfile { name: "Sony Camera Color", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.02, contrast: 1.0 }
  } else {
    CameraProfile { name: "Camera Embedded", rgb_balance: [1.0, 1.0, 1.0], saturation: 1.0, contrast: 1.0 }
  }
}

fn encode_srgb(value: f32) -> u8 {
  let value = value.clamp(0.0, 1.0);
  let encoded = if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 };
  (encoded.clamp(0.0, 1.0) * 255.0).round() as u8
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
  Ok(RawDecodeResult { png, camera_make: camera_make.to_string(), camera_model: camera_model.to_string(), profile: format!("{} (embedded preview)", profile.name) })
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
      let matrix_srgb = [
        3.2406 * xyz[0] - 1.5372 * xyz[1] - 0.4986 * xyz[2],
        -0.9689 * xyz[0] + 1.8758 * xyz[1] + 0.0415 * xyz[2],
        0.0557 * xyz[0] - 0.2040 * xyz[1] + 1.0570 * xyz[2],
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
  let mut rgb = vec![0_u8; output_width * output_height * 3];
  for (index, pixel) in linear_rgb.into_iter().enumerate() {
    for channel in 0..3 {
      let mut value = pixel[channel] * exposure_gain;
      // Preserve a little headroom before clipping highlights.
      value = if value > 1.0 { 1.0 + (1.0 - (-(value - 1.0)).exp()) * 0.12 } else { value };
      let luma = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
      value = luma + (value - luma) * profile.saturation;
      value = ((value - 0.5) * profile.contrast + 0.5).max(0.0);
      rgb[index * 3 + channel] = encode_srgb(value);
    }
  }

  let mut png = Vec::new();
  PngEncoder::new(&mut png)
    .write_image(&rgb, output_width as u32, output_height as u32, ColorType::Rgb8.into())
    .map_err(|error| format!("RAW preview encoding failed: {error}"))?;
  Ok(RawDecodeResult { png, camera_make: raw.clean_make, camera_model: raw.clean_model, profile: profile.name.to_string() })
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
      assert!(result.png.starts_with(b"\x89PNG\r\n\x1a\n"));
      assert!(result.png.len() > 1024);
      let rendered = image::load_from_memory(&result.png).expect("preview PNG should be readable").to_rgb8();
      assert!(rendered.pixels().any(|pixel| pixel.0.iter().any(|value| *value > 8)), "preview should not be black");
    }
  }
}

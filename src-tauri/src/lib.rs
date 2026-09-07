use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use rawler::{decoders::RawDecodeParams, rawimage::RawImageData, rawsource::RawSource};

#[tauri::command]
fn decode_raw(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
  let source = RawSource::new_from_slice(&bytes);
  let raw = rawler::decode(&source, &RawDecodeParams::default())
    .map_err(|error| format!("RAW decode failed: {error}"))?;

  if raw.cpp != 1 {
    return Err("This RAW file is not a supported Bayer image".to_string());
  }

  let pixels = match &raw.data {
    RawImageData::Integer(values) => values,
    RawImageData::Float(_) => return Err("Floating-point RAW previews are not supported yet".to_string()),
  };
  let width = raw.width;
  let height = raw.height;
  let scale = (2400.0 / width.max(height) as f32).min(1.0);
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
  let camera_to_xyz = raw.cam_to_xyz_normalized();
  let mut linear_rgb = vec![[0.0_f32; 3]; output_width * output_height];
  let mut linear_peak = 0.0_f32;

  for output_y in 0..output_height {
    for output_x in 0..output_width {
      let y = ((output_y as f32 / scale).round() as usize).min(height - 1);
      let x = ((output_x as f32 / scale).round() as usize).min(width - 1);
      let output = output_y * output_width + output_x;
      let mut camera_rgb = [0.0_f32; 4];
      for channel in 0..3 {
        let mut sum = 0.0_f32;
        let mut count = 0_u32;
        for dy in -1..=1 {
          for dx in -1..=1 {
            let sample_y = y as isize + dy;
            let sample_x = x as isize + dx;
            if sample_y < 0 || sample_x < 0 || sample_y >= height as isize || sample_x >= width as isize {
              continue;
            }
            let sample_y = sample_y as usize;
            let sample_x = sample_x as usize;
            if raw.camera.cfa.color_at(sample_y, sample_x) != channel {
              continue;
            }
            let black = black_levels[channel];
            let white = white_levels[channel].max(black + 1.0);
            let value = pixels[sample_y * width + sample_x] as f32;
            sum += ((value - black) / (white - black)).clamp(0.0, 1.0);
            count += 1;
          }
        }
        camera_rgb[channel] = if count == 0 { 0.0 } else { sum / count as f32 } * white_balance[channel];
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
      let matrix_peak = matrix_srgb.iter().copied().fold(0.0_f32, f32::max);
      let matrix_sum = matrix_srgb.iter().copied().filter(|value| value.is_finite() && *value > 0.0).sum::<f32>();
      let srgb = if matrix_peak.is_finite() && matrix_peak > 0.02 && matrix_sum > 0.01 {
        matrix_srgb
      } else {
        [camera_rgb[0], camera_rgb[1], camera_rgb[2]]
      };
      let clean = [
        srgb[0].max(0.0),
        srgb[1].max(0.0),
        srgb[2].max(0.0),
      ];
      linear_rgb[output] = clean;
      linear_peak = linear_peak.max(clean[0].max(clean[1]).max(clean[2]));
    }
  }

  let exposure_gain = if linear_peak.is_finite() && linear_peak > 0.01 {
    (0.82 / linear_peak).clamp(0.75, 8.0)
  } else {
    1.0
  };
  let mut rgb = vec![0_u8; output_width * output_height * 3];
  for (index, pixel) in linear_rgb.into_iter().enumerate() {
    for channel in 0..3 {
      let value = (pixel[channel] * exposure_gain).clamp(0.0, 1.0);
      let encoded = if value <= 0.0031308 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 };
      rgb[index * 3 + channel] = (encoded.clamp(0.0, 1.0) * 255.0) as u8;
    }
  }

  let mut png = Vec::new();
  PngEncoder::new(&mut png)
    .write_image(&rgb, output_width as u32, output_height as u32, ColorType::Rgb8.into())
    .map_err(|error| format!("RAW preview encoding failed: {error}"))?;
  Ok(png)
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
  fn canon_fixtures_decode_to_png() {
    for fixture in [
      include_bytes!("../../Test Photos/1.CR3"),
      include_bytes!("../../Test Photos/2.CR3"),
      include_bytes!("../../Test Photos/3.CR3"),
    ] {
      let png = decode_raw(fixture.to_vec()).expect("Canon fixture should decode");
      assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
      assert!(png.len() > 1024);
    }
  }
}

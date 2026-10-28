/// DNG SDK linearisation: the lookup and per-CFA black term are rounded separately
/// to 24.8 fixed point, then their difference is rounded to u16.
pub(super) fn table(black: u16, white: f64, bits: u32) -> Vec<f32> {
  let preserve = (black as u32) << (16 - bits);
  let scale = 1.0 / (white - black as f64);
  let range = (65535 - preserve) as f64;
  let bk = (scale * black as f64 * (range * 256.0)).round() as i64;
  (0..65536)
    .map(|raw| {
      let v = ((preserve as f64 + range * (scale * raw as f64)) * 256.0).round() as i64;
      let code = ((v - bk + 128) >> 8).clamp(0, 65535);
      code as f32 * (1.0 / 65535.0)
    })
    .collect()
}

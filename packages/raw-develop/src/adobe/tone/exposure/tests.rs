use super::{Stage, Table};

#[test]
fn batched_exposure_matches_scalar_bits() {
  let curves = [
    Table::new(64, |x| x.sqrt()),
    Table::new(64, |x| (x - 0.03).max(0.0)),
    Table::new(64, |x| x * (0.75 + x * 0.25)),
  ];
  let mut seed = 17u32;
  for mode in 0..128 {
    let stage = Stage {
      gain: [0.25, 1.0, 8.0][mode % 3],
      rolloff_gain: if mode & 2 != 0 { 4.0 } else { 1.0 },
      rolloff: (mode & 1 != 0).then(|| curves[0].clone()),
      overrange_squared_gain: if mode & 4 != 0 { 16.0 } else { 1.0 },
      whites_clip_squared: if mode & 8 != 0 { 0.03125 } else { 1.0 },
      whites_reduce: (mode & 16 != 0).then(|| curves[2].clone()),
      blacks_subtract: (mode & 32 != 0).then(|| curves.clone()),
      blacks_lift: (mode & 64 != 0).then(|| curves[0].clone()),
      epsilon: if mode % 5 == 0 { 0.0 } else { 2f32.powi(-16) },
    };
    for sample in 0..2048 {
      let pixels = std::array::from_fn(|i| {
        std::array::from_fn(|c| {
          seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
          match sample % 23 {
            0 => {
              if (i + c) % 2 == 0 {
                -0.0
              } else {
                0.0
              }
            }
            1 => 1.0,
            2 => (i % 3 == c) as u8 as f32,
            3 => f32::from_bits(seed & 0x807f_ffff),
            4 => {
              if c == 0 {
                1e-37
              } else {
                -1e-37
              }
            }
            5 => (seed >> 16) as f32 * (64.0 / 65535.0),
            6 => {
              if c == i % 3 {
                f32::NAN
              } else {
                0.5
              }
            }
            7 => i as f32 * 0.25,
            8 => stage.epsilon,
            9 => {
              if c == i % 3 {
                f32::INFINITY
              } else {
                0.5
              }
            }
            _ => (seed >> 16) as f32 * (2.0 / 65535.0) - 0.25,
          }
        })
      });
      let expected = pixels.map(|p| stage.pixel(p));
      let actual = stage.pixels4(pixels);
      assert_eq!(
        actual.map(|p| p.map(f32::to_bits)),
        expected.map(|p| p.map(f32::to_bits)),
        "mode {mode}, sample {sample}, {pixels:?}"
      );
    }
  }
}

//! Digests of 4,097 f64 results per native function/parameter combination.
//! Captured directly from DNG Converter 18.7 with tone_functions_runtime.py.
//! These are synthetic scalar inputs, without photographic image data.
use super::{
  blacks::lift_eval,
  curves::{Brightness, Contrast, Whites},
};
const CAPTURES: &[(&str, u64)] = &[
  ("black_lift_0.03125", 0x4c6e97b059d94161),
  ("black_lift_0.125", 0x474f85467497c9de),
  ("black_lift_0.25", 0x8a5ec6016c0d09c5),
  ("brightness_-0.5", 0xfb661b5fbb98b0b8),
  ("brightness_-1", 0x465611405891331d),
  ("brightness_-2", 0x5896b1e7a4310701),
  ("brightness_-8", 0x0091f729763bf5ee),
  ("brightness_0.25", 0xf1f1431fb0f2190b),
  ("brightness_0", 0x1b96b773474e5bfd),
  ("brightness_1", 0x8613a42319ef4595),
  ("brightness_2", 0x7352ae62f15e2e3b),
  ("brightness_4", 0x1a81f7d15262b1b3),
  ("brightness_8", 0x0b2987d45e3c25a1),
  ("contrast_0.01125_-100", 0x72d49b201aa81e5b),
  ("contrast_0.01125_-50", 0x7670018c505965af),
  ("contrast_0.01125_0", 0x735b36e6ed847668),
  ("contrast_0.01125_100", 0xa99c18267e552c2f),
  ("contrast_0.01125_50", 0x50e080ad41ed4792),
  ("contrast_0.09_-100", 0xb517c3aa7bfec119),
  ("contrast_0.09_-50", 0x55a20a256ddb18ad),
  ("contrast_0.09_0", 0xb898c7ca6de5ed03),
  ("contrast_0.09_100", 0xd607b2e50583a5c5),
  ("contrast_0.09_50", 0x523a4ade5d2557fd),
  ("contrast_0.18_-100", 0xa3a1a8d17bf52588),
  ("contrast_0.18_-50", 0x2cc3d164d829ad57),
  ("contrast_0.18_0", 0x631414c080b00fff),
  ("contrast_0.18_100", 0xea3f5b8738a877fa),
  ("contrast_0.18_50", 0x3a10f72d7bbcdeef),
  ("contrast_0.36_-100", 0x24748e0be67432d6),
  ("contrast_0.36_-50", 0xb9e27e9e819e49f6),
  ("contrast_0.36_0", 0x2d97f97e19a9a625),
  ("contrast_0.36_100", 0x3c6ea7c584ebe85e),
  ("contrast_0.36_50", 0x1578ec491b26f538),
  ("contrast_2.88_-100", 0x89096662e2c079ed),
  ("contrast_2.88_-50", 0x0358eff7ff33bcaf),
  ("contrast_2.88_0", 0xd38f5dba7f5c97c6),
  ("contrast_2.88_100", 0x7341c2f2f0f86561),
  ("contrast_2.88_50", 0x6ccc2efc7d51a663),
  ("white_reduce_0.25", 0x03eedbbb32fa75a9),
  ("white_reduce_0.5", 0x4e2b873cb3d4d553),
  ("white_reduce_1", 0x3c5669384cc6d84e),
  ("white_reduce_2", 0xe2dc04e69437d2f8),
];
#[test]
fn scalar_functions_match_native_f64_payloads() {
  for &(name, expected) in CAPTURES {
    let parts: Vec<_> = name.split('_').collect();
    let f: Box<dyn Fn(f64) -> f64> = match parts[0] {
      "brightness" => {
        let f = Brightness::new(parts[1].parse().unwrap());
        Box::new(move |x| f.eval(x))
      }
      "contrast" => {
        let f = Contrast::new(parts[2].parse().unwrap(), parts[1].parse().unwrap());
        Box::new(move |x| f.eval(x))
      }
      "white" => {
        let f = Whites::new(parts[2].parse().unwrap(), 1.0);
        Box::new(move |x| f.eval(x))
      }
      "black" => {
        let fraction = parts[2].parse().unwrap();
        Box::new(move |x| lift_eval(fraction, x))
      }
      _ => unreachable!(),
    };
    let hash = (0..=4096)
      .map(|i| f(i as f64 * (1.0 / 4096.0)))
      .flat_map(f64::to_le_bytes)
      .fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
      });
    assert_eq!(hash, expected, "{name}");
  }
}

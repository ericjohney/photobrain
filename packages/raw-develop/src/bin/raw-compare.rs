//! Compare two `.f32` images (see tools/apple-reference) as Display P3.
//!
//!   raw-compare final <ours.f32> <apple.f32>    both display-encoded P3 (sRGB transfer)
//!   raw-compare linear <ours.f32> <apple.f32>   both scene-linear P3
//!
//! The larger image is box-downscaled to the smaller one's size when they differ by an
//! integer factor. Prints mean / median / p95 CIEDE2000 and mean per-channel error.

use std::process::ExitCode;

struct Img {
  w: usize,
  h: usize,
  d: Vec<f32>,
}

fn load(p: &str) -> Result<Img, String> {
  let b = std::fs::read(p).map_err(|e| format!("{p}: {e}"))?;
  if b.len() < 16 || &b[..5] != b"RDF32" {
    return Err(format!("{p}: not an RDF32 file"));
  }
  let w = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
  let h = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
  let d: Vec<f32> = b[16..]
    .chunks_exact(4)
    .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
    .collect();
  if d.len() != w * h * 3 {
    return Err(format!("{p}: size mismatch"));
  }
  Ok(Img { w, h, d })
}

fn downscale(i: &Img, f: usize) -> Img {
  let (w, h) = (i.w / f, i.h / f);
  let mut d = vec![0.0; w * h * 3];
  for y in 0..h {
    for x in 0..w {
      for c in 0..3 {
        let mut s = 0.0;
        for dy in 0..f {
          for dx in 0..f {
            s += i.d[((y * f + dy) * i.w + x * f + dx) * 3 + c];
          }
        }
        d[(y * w + x) * 3 + c] = s / (f * f) as f32;
      }
    }
  }
  Img { w, h, d }
}

fn decode(v: f32) -> f64 {
  let v = v as f64;
  if v <= 0.04045 {
    v / 12.92
  } else {
    ((v + 0.055) / 1.055).powf(2.4)
  }
}

/// Linear Display P3 -> CIELAB (D65 reference white).
fn lab(rgb: [f64; 3]) -> [f64; 3] {
  let m = [
    [0.486_570_95, 0.265_667_69, 0.198_217_29],
    [0.228_974_56, 0.691_738_52, 0.079_286_91],
    [0.0, 0.045_113_38, 1.043_944_37],
  ];
  let xyz: Vec<f64> = (0..3)
    .map(|i| m[i][0] * rgb[0] + m[i][1] * rgb[1] + m[i][2] * rgb[2])
    .collect();
  let wp = [0.950_47, 1.0, 1.088_83];
  let f = |t: f64| {
    if t > 216.0 / 24389.0 {
      t.cbrt()
    } else {
      (24389.0 / 27.0 * t + 16.0) / 116.0
    }
  };
  let (fx, fy, fz) = (f(xyz[0] / wp[0]), f(xyz[1] / wp[1]), f(xyz[2] / wp[2]));
  [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn de2000(a: [f64; 3], b: [f64; 3]) -> f64 {
  use std::f64::consts::PI;
  let (l1, a1, b1) = (a[0], a[1], a[2]);
  let (l2, a2, b2) = (b[0], b[1], b[2]);
  let c1 = (a1 * a1 + b1 * b1).sqrt();
  let c2 = (a2 * a2 + b2 * b2).sqrt();
  let cm = (c1 + c2) / 2.0;
  let g = 0.5 * (1.0 - (cm.powi(7) / (cm.powi(7) + 25f64.powi(7))).sqrt());
  let (a1p, a2p) = (a1 * (1.0 + g), a2 * (1.0 + g));
  let (c1p, c2p) = ((a1p * a1p + b1 * b1).sqrt(), (a2p * a2p + b2 * b2).sqrt());
  let hp = |b: f64, a: f64| {
    let h = b.atan2(a).to_degrees();
    if h < 0.0 { h + 360.0 } else { h }
  };
  let (h1p, h2p) = (hp(b1, a1p), hp(b2, a2p));
  let dl = l2 - l1;
  let dc = c2p - c1p;
  let mut dh = h2p - h1p;
  if c1p * c2p != 0.0 {
    if dh > 180.0 {
      dh -= 360.0;
    } else if dh < -180.0 {
      dh += 360.0;
    }
  } else {
    dh = 0.0;
  }
  let dhh = 2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin();
  let lm = (l1 + l2) / 2.0;
  let cmp = (c1p + c2p) / 2.0;
  let hm = if c1p * c2p == 0.0 {
    h1p + h2p
  } else if (h1p - h2p).abs() <= 180.0 {
    (h1p + h2p) / 2.0
  } else if h1p + h2p < 360.0 {
    (h1p + h2p + 360.0) / 2.0
  } else {
    (h1p + h2p - 360.0) / 2.0
  };
  let t = 1.0 - 0.17 * (hm - 30.0).to_radians().cos()
    + 0.24 * (2.0 * hm).to_radians().cos()
    + 0.32 * (3.0 * hm + 6.0).to_radians().cos()
    - 0.20 * (4.0 * hm - 63.0).to_radians().cos();
  let dtheta = 30.0 * (-((hm - 275.0) / 25.0).powi(2)).exp();
  let rc = 2.0 * (cmp.powi(7) / (cmp.powi(7) + 25f64.powi(7))).sqrt();
  let sl = 1.0 + 0.015 * (lm - 50.0).powi(2) / (20.0 + (lm - 50.0).powi(2)).sqrt();
  let sc = 1.0 + 0.045 * cmp;
  let sh = 1.0 + 0.015 * cmp * t;
  let rt = -(2.0 * dtheta * PI / 180.0).sin() * rc;
  ((dl / sl).powi(2) + (dc / sc).powi(2) + (dhh / sh).powi(2) + rt * (dc / sc) * (dhh / sh)).sqrt()
}

fn main() -> ExitCode {
  let a: Vec<String> = std::env::args().skip(1).collect();
  if a.len() != 3 || !matches!(a[0].as_str(), "final" | "linear") {
    eprintln!("usage: raw-compare final|linear <ours.f32> <apple.f32>");
    return ExitCode::from(2);
  }
  let (mut x, mut y) = match (load(&a[1]), load(&a[2])) {
    (Ok(x), Ok(y)) => (x, y),
    (Err(e), _) | (_, Err(e)) => {
      eprintln!("{e}");
      return ExitCode::FAILURE;
    }
  };
  if x.w > y.w {
    let f = (x.w as f64 / y.w as f64).round() as usize;
    x = downscale(&x, f);
  } else if y.w > x.w {
    let f = (y.w as f64 / x.w as f64).round() as usize;
    y = downscale(&y, f);
  }
  let (w, h) = (x.w.min(y.w), x.h.min(y.h));
  let linear = a[0] == "linear";
  let mut des = Vec::with_capacity(w * h);
  let mut ch = [0.0f64; 3];
  // Skip a 2% border (resampling edges).
  let (bx, by) = (w / 50, h / 50);
  for py in by..h - by {
    for px in bx..w - bx {
      let get = |i: &Img| -> [f64; 3] {
        let o = (py * i.w + px) * 3;
        let v = [i.d[o], i.d[o + 1], i.d[o + 2]];
        if linear {
          v.map(|c| (c as f64).max(0.0))
        } else {
          v.map(decode)
        }
      };
      let (p, q) = (get(&x), get(&y));
      for c in 0..3 {
        ch[c] += p[c] - q[c];
      }
      des.push(de2000(lab(p), lab(q)));
    }
  }
  let n = des.len() as f64;
  des.sort_by(|a, b| a.total_cmp(b));
  let mean = des.iter().sum::<f64>() / n;
  println!(
    "{}x{} dE00 mean {:.2} median {:.2} p95 {:.2} | mean diff (ours-apple, linear) R {:+.4} G {:+.4} B {:+.4}",
    w,
    h,
    mean,
    des[des.len() / 2],
    des[des.len() * 95 / 100],
    ch[0] / n,
    ch[1] / n,
    ch[2] / n
  );
  ExitCode::SUCCESS
}

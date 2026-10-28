//! Directional red/blue reconstruction in Adobe 18.7's `cr_stage_new_fuji6x6`.
//! Case tables transcribed from the observed arithmetic; explicit FMA boundaries matter.
#![allow(unused_parens, unused_mut, clippy::needless_late_init)]
use super::{Plane, fm};
const Q: f32 = 0.25;
const H3: f32 = 0.75;
const HALF: f32 = 0.5;
const EIGHTH: f32 = 0.125;
fn dir2(c: f32, a: f32, wa: f32, b: f32, wb: f32) -> f32 {
  c + fm(b, wb, a * wa)
}
fn lin2(a: f32, wa: f32, b: f32, wb: f32) -> f32 {
  fm(b, wb, a * wa)
}
fn ahalf(c: f32, y: f32, z: f32) -> f32 {
  c + fm(z, -0.5, y)
}
fn clamp4(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  a.min(b).min(c).min(d).max(v.min(a.max(b).max(c).max(d)))
}
pub(super) fn reconstruct(p: &Plane, y: usize, x: usize, mode: usize, k: u8) -> (f32, f32) {
  match mode {
    0 => mode0(p, y, x, k),
    1 => mode1(p, y, x, k),
    2 => mode2(p, y, x, k),
    3 => mode3(p, y, x, k),
    4 => mode4(p, y, x, k),
    5 => mode5(p, y, x, k),
    6 => mode6(p, y, x, k),
    7 => mode7(p, y, x, k),
    8 => mode8(p, y, x, k),
    _ => unreachable!(),
  }
}
fn mode0(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut e1: f32;
  let mut e2: f32;
  let mut reg: f32;
  let mut reg1: f32;
  let mut reg2: f32;
  let mut s218: f32;
  let mut s246: f32;
  let mut s248: f32;
  let mut s250: f32;
  let mut t216: f32;
  let mut t246: f32;
  let mut t248: f32;
  let mut t250: f32;
  let mut w255: f32;
  let mut w275: f32;
  c = p.tap(y, x, 0, 0);
  (t246, t250, t248, t216) = (
    p.tap(y, x, -(2), 0),
    p.tap(y, x, -(1), -(2)),
    p.tap(y, x, 0, 1),
    p.tap(y, x, 1, -(1)),
  );
  if k == 0 {
    if (p.tap(y, x, 5, 0) - c).abs() <= (p.tap(y, x, -(3), 0) - c).abs() {
      (w255, reg) = (Q, H3);
    } else {
      (w255, reg) = (H3, Q);
    }
    e = dir2(
      c,
      (p.tap(y, x, 4, 0) - p.tap(y, x, 5, 0)),
      reg,
      (t246 - p.tap(y, x, -(3), 0)),
      w255,
    );
  } else {
    if k == 1 {
      e = ahalf(c, t248, (c + p.tap(y, x, 0, 2)));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, -(2), 2), Q, t216, H3);
      } else {
        if k == 3 {
          e = (c + ((((t248 + t216) - p.tap(y, x, -(1), 0)) - p.tap(y, x, 2, 0)) * HALF));
        } else {
          e = (((t216 * Q) + (t248 * HALF)) + ((t246 + t250) * EIGHTH));
        }
      }
    }
  }
  e1 = clamp4(e, t216, t248, t246, t250);
  (s248, s218, s246, s250) = (
    p.tap(y, x, 0, -(2)),
    p.tap(y, x, -(2), -(1)),
    p.tap(y, x, 1, 0),
    p.tap(y, x, -(1), 1),
  );
  if k == 0 {
    e = ahalf(c, s246, (c + p.tap(y, x, 2, 0)));
  } else {
    if k == 1 {
      reg1 = p.tap(y, x, 0, -(3));
      if (p.tap(y, x, 0, 5) - c).abs() <= (reg1 - c).abs() {
        (w275, reg2) = (H3, Q);
      } else {
        (w275, reg2) = (Q, H3);
      }
      e = dir2(
        c,
        (p.tap(y, x, 0, 4) - p.tap(y, x, 0, 5)),
        w275,
        (s248 - reg1),
        reg2,
      );
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, 2, -(2)), Q, s250, H3);
      } else {
        if k == 3 {
          e = (c + ((((s246 + s250) - p.tap(y, x, 0, -(1))) - p.tap(y, x, 0, 2)) * HALF));
        } else {
          e = (((s250 * Q) + (s246 * HALF)) + ((s248 + s218) * EIGHTH));
        }
      }
    }
  }
  e2 = clamp4(e, s246, s250, s248, s218);
  (e1, e2)
}
fn mode4(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut base: f32;
  let mut c: f32;
  let mut d2: f32;
  let mut dn: f32;
  let mut e: f32;
  let mut e1: f32;
  let mut e2: f32;
  let mut l1: f32;
  let mut lf: f32;
  let mut q: f32;
  let mut r1: f32;
  let mut rt: f32;
  let mut u2: f32;
  let mut up: f32;
  c = p.tap(y, x, 0, 0);
  (up, dn, lf, rt) = (
    p.tap(y, x, -(1), 0),
    p.tap(y, x, 1, 0),
    p.tap(y, x, 0, -(2)),
    p.tap(y, x, 0, 2),
  );
  if k == 0 {
    e = ((up + dn) * HALF);
  } else {
    if k == 1 {
      e = ((lf + rt) * HALF);
    } else {
      base = ((((up + dn) + lf) + rt) * Q);
      if k == 3 {
        q = (((p.tap(y, x, -(1), 1) + p.tap(y, x, 1, -(1))) + p.tap(y, x, -(2), -(1)))
          + p.tap(y, x, 2, 1));
        e = ((base + c) + (q * -(0.25)));
      } else {
        if k == 2 {
          q = (((p.tap(y, x, -(1), -(1)) + p.tap(y, x, 1, 1)) + p.tap(y, x, -(2), 1))
            + p.tap(y, x, 2, -(1)));
          e = ((base + c) + (q * -(0.25)));
        } else {
          e = base;
        }
      }
    }
  }
  e1 = clamp4(e, up, dn, lf, rt);
  (l1, r1, u2, d2) = (
    p.tap(y, x, 0, -(1)),
    p.tap(y, x, 0, 1),
    p.tap(y, x, -(2), 0),
    p.tap(y, x, 2, 0),
  );
  if k == 0 {
    e = ((u2 + d2) * HALF);
  } else {
    if k == 1 {
      e = ((l1 + r1) * HALF);
    } else {
      base = ((((l1 + r1) + u2) + d2) * Q);
      if k == 3 {
        q = (((p.tap(y, x, 1, -(1)) + p.tap(y, x, -(1), 1)) + p.tap(y, x, -(1), -(2)))
          + p.tap(y, x, 1, 2));
        e = ((base + c) + (q * -(0.25)));
      } else {
        if k == 2 {
          q = (((p.tap(y, x, -(1), -(1)) + p.tap(y, x, 1, 1)) + p.tap(y, x, 1, -(2)))
            + p.tap(y, x, -(1), 2));
          e = ((base + c) + (q * -(0.25)));
        } else {
          e = base;
        }
      }
    }
  }
  e2 = clamp4(e, l1, r1, u2, d2);
  (e1, e2)
}
fn mode1(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut hi: f32;
  let mut lo: f32;
  let mut reg: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut v250: f32;
  let mut v255: f32;
  let mut w: f32;
  c = p.tap(y, x, 0, 0);
  (v246, v250, v218, v248, v255) = (
    p.tap(y, x, -(1), 0),
    p.tap(y, x, 1, 1),
    p.tap(y, x, 1, -(1)),
    p.tap(y, x, 0, 3),
    p.tap(y, x, 0, -(3)),
  );
  if k == 0 {
    e = (c + ((((v246 + p.tap(y, x, 3, 0)) - c) - p.tap(y, x, 2, 0)) * HALF));
  } else {
    if k == 1 {
      if (p.tap(y, x, 0, -(4)) - c).abs() <= (p.tap(y, x, 0, 4) - c).abs() {
        (w, reg) = (Q, H3);
      } else {
        (w, reg) = (H3, Q);
      }
      e = ((((v248 - p.tap(y, x, 0, 4)) * w)
        + ((p.tap(y, x, 0, 1) + p.tap(y, x, 0, -(1))) * HALF))
        + ((v255 - p.tap(y, x, 0, -(4))) * reg));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, -(2), 2), Q, v218, H3);
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, -(2), -(2)), Q, v250, H3);
        } else {
          e = (((v250 + v218) * Q) + (v246 * HALF));
        }
      }
    }
  }
  lo = ((((v246).min(v250)).min(v248)).min(v255)).min(v218);
  hi = ((((v246).max(v250)).max(v248)).max(v255)).max(v218);
  (c, (lo).max((e).min(hi)))
}
fn mode3(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut hi: f32;
  let mut lo: f32;
  let mut v216: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut v250: f32;
  let mut w: f32;
  let mut w255: f32;
  c = p.tap(y, x, 0, 0);
  (v246, v216, v250, v248, v218) = (
    p.tap(y, x, 0, -(1)),
    p.tap(y, x, -(1), 1),
    p.tap(y, x, 1, 1),
    p.tap(y, x, -(3), 0),
    p.tap(y, x, 3, 0),
  );
  if k == 0 {
    if (p.tap(y, x, 4, 0) - c).abs() <= (p.tap(y, x, -(4), 0) - c).abs() {
      (w, w255) = (Q, H3);
    } else {
      (w, w255) = (H3, Q);
    }
    e = ((((v248 - p.tap(y, x, -(4), 0)) * w)
      + ((p.tap(y, x, -(1), 0) + p.tap(y, x, 1, 0)) * HALF))
      + ((v218 - p.tap(y, x, 4, 0)) * w255));
  } else {
    if k == 1 {
      e = (c + ((((v246 + p.tap(y, x, 0, 3)) - c) - p.tap(y, x, 0, 2)) * HALF));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, 2, -(2)), Q, v216, H3);
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, -(2), -(2)), Q, v250, H3);
        } else {
          e = (((v216 + v250) * Q) + (v246 * HALF));
        }
      }
    }
  }
  lo = ((((v246).min(v216)).min(v248)).min(v218)).min(v250);
  hi = ((((v246).max(v216)).max(v248)).max(v218)).max(v250);
  ((lo).max((e).min(hi)), c)
}
fn mode5(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut hi: f32;
  let mut lo: f32;
  let mut v216: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut v250: f32;
  let mut w: f32;
  let mut w255: f32;
  c = p.tap(y, x, 0, 0);
  (v246, v216, v250, v248, v218) = (
    p.tap(y, x, 0, 1),
    p.tap(y, x, -(1), -(1)),
    p.tap(y, x, 1, -(1)),
    p.tap(y, x, -(3), 0),
    p.tap(y, x, 3, 0),
  );
  if k == 0 {
    if (p.tap(y, x, 4, 0) - c).abs() <= (p.tap(y, x, -(4), 0) - c).abs() {
      (w, w255) = (Q, H3);
    } else {
      (w, w255) = (H3, Q);
    }
    e = ((((v248 - p.tap(y, x, -(4), 0)) * w)
      + ((p.tap(y, x, -(1), 0) + p.tap(y, x, 1, 0)) * HALF))
      + ((v218 - p.tap(y, x, 4, 0)) * w255));
  } else {
    if k == 1 {
      e = (c + ((((v246 + p.tap(y, x, 0, -(3))) - c) - p.tap(y, x, 0, -(2))) * HALF));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, -(2), 2), Q, v250, H3);
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, 2, 2), Q, v216, H3);
        } else {
          e = (((v216 + v250) * Q) + (v246 * HALF));
        }
      }
    }
  }
  lo = ((((v246).min(v216)).min(v248)).min(v218)).min(v250);
  hi = ((((v246).max(v216)).max(v248)).max(v218)).max(v250);
  ((lo).max((e).min(hi)), c)
}
fn mode7(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut hi: f32;
  let mut lo: f32;
  let mut reg: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut v250: f32;
  let mut v255: f32;
  let mut w: f32;
  c = p.tap(y, x, 0, 0);
  (v248, v250, v218, v246, v255) = (
    p.tap(y, x, 1, 0),
    p.tap(y, x, -(1), 1),
    p.tap(y, x, -(1), -(1)),
    p.tap(y, x, 0, 3),
    p.tap(y, x, 0, -(3)),
  );
  if k == 0 {
    e = (c + ((((v248 + p.tap(y, x, -(3), 0)) - c) - p.tap(y, x, -(2), 0)) * HALF));
  } else {
    if k == 1 {
      if (p.tap(y, x, 0, -(4)) - c).abs() <= (p.tap(y, x, 0, 4) - c).abs() {
        (w, reg) = (Q, H3);
      } else {
        (w, reg) = (H3, Q);
      }
      e = ((((v246 - p.tap(y, x, 0, 4)) * w)
        + ((p.tap(y, x, 0, 1) + p.tap(y, x, 0, -(1))) * HALF))
        + ((v255 - p.tap(y, x, 0, -(4))) * reg));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, 2, -(2)), Q, v250, H3);
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, 2, 2), Q, v218, H3);
        } else {
          e = (((v250 + v218) * Q) + (v248 * HALF));
        }
      }
    }
  }
  lo = ((((v248).min(v250)).min(v246)).min(v255)).min(v218);
  hi = ((((v248).max(v250)).max(v246)).max(v255)).max(v218);
  (c, (lo).max((e).min(hi)))
}
fn mode2(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut e1: f32;
  let mut e2: f32;
  let mut reg: f32;
  let mut s218: f32;
  let mut s246: f32;
  let mut s248: f32;
  let mut s250: f32;
  let mut v216: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut w: f32;
  let mut w255: f32;
  c = p.tap(y, x, 0, 0);
  (v248, v246, v216) = (
    p.tap(y, x, -(1), 2),
    p.tap(y, x, 0, -(1)),
    p.tap(y, x, 1, 1),
  );
  if k == 2 {
    v218 = p.tap(y, x, -(2), 0);
    e = (c + ((((v246 + v216) - p.tap(y, x, -(1), 0)) - p.tap(y, x, 2, 0)) * HALF));
  } else {
    if k == 3 {
      v218 = p.tap(y, x, -(2), 0);
      e = lin2(p.tap(y, x, -(2), -(2)), Q, v216, H3);
    } else {
      v218 = p.tap(y, x, -(2), 0);
      if k == 0 {
        if (p.tap(y, x, 5, 0) - c).abs() <= (p.tap(y, x, -(3), 0) - c).abs() {
          (w255, reg) = (Q, H3);
        } else {
          (w255, reg) = (H3, Q);
        }
        e = dir2(
          c,
          (p.tap(y, x, 4, 0) - p.tap(y, x, 5, 0)),
          reg,
          (v218 - p.tap(y, x, -(3), 0)),
          w255,
        );
      } else {
        if k == 1 {
          e = ahalf(c, v246, (c + p.tap(y, x, 0, -(2))));
        } else {
          e = (((v216 * Q) + (v246 * HALF)) + ((v248 + v218) * EIGHTH));
        }
      }
    }
  }
  e1 = clamp4(e, v246, v216, v218, v248);
  (s248, s218, s246, s250) = (
    p.tap(y, x, 0, 2),
    p.tap(y, x, -(2), 1),
    p.tap(y, x, 1, 0),
    p.tap(y, x, -(1), -(1)),
  );
  if k == 0 {
    e = ahalf(c, s246, (c + p.tap(y, x, 2, 0)));
  } else {
    if k == 1 {
      if (p.tap(y, x, 0, -(5)) - c).abs() <= (p.tap(y, x, 0, 3) - c).abs() {
        (w, reg) = (H3, Q);
      } else {
        (w, reg) = (Q, H3);
      }
      e = dir2(
        c,
        (p.tap(y, x, 0, -(4)) - p.tap(y, x, 0, -(5))),
        w,
        (s248 - p.tap(y, x, 0, 3)),
        reg,
      );
    } else {
      if k == 2 {
        e = (c + ((((s246 + s250) - p.tap(y, x, 0, 1)) - p.tap(y, x, 0, -(2))) * HALF));
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, 2, 2), Q, s250, H3);
        } else {
          e = (((s250 * Q) + (s246 * HALF)) + ((s248 + s218) * EIGHTH));
        }
      }
    }
  }
  e2 = clamp4(e, s246, s250, s248, s218);
  (e1, e2)
}
fn mode6(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut e1: f32;
  let mut e2: f32;
  let mut reg: f32;
  let mut s246: f32;
  let mut s248: f32;
  let mut s250: f32;
  let mut s255: f32;
  let mut v216: f32;
  let mut v218: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut w: f32;
  c = p.tap(y, x, 0, 0);
  (v248, v246, v216) = (
    p.tap(y, x, 1, -(2)),
    p.tap(y, x, 0, 1),
    p.tap(y, x, -(1), -(1)),
  );
  v218 = p.tap(y, x, 2, 0);
  if k == 2 {
    e = (c + ((((v246 + v216) - p.tap(y, x, 1, 0)) - p.tap(y, x, -(2), 0)) * HALF));
  } else {
    if k == 3 {
      e = lin2(p.tap(y, x, 2, 2), Q, v216, H3);
    } else {
      if k == 0 {
        if (p.tap(y, x, -(5), 0) - c).abs() <= (p.tap(y, x, 3, 0) - c).abs() {
          (w, reg) = (Q, H3);
        } else {
          (w, reg) = (H3, Q);
        }
        e = dir2(
          c,
          (p.tap(y, x, -(4), 0) - p.tap(y, x, -(5), 0)),
          reg,
          (v218 - p.tap(y, x, 3, 0)),
          w,
        );
      } else {
        if k == 1 {
          e = ahalf(c, v246, (c + p.tap(y, x, 0, 2)));
        } else {
          e = (((v216 * Q) + (v246 * HALF)) + ((v248 + v218) * EIGHTH));
        }
      }
    }
  }
  e1 = clamp4(e, v246, v216, v218, v248);
  (s248, s246, s250, s255) = (
    p.tap(y, x, 0, -(2)),
    p.tap(y, x, -(1), 0),
    p.tap(y, x, 1, 1),
    p.tap(y, x, 2, -(1)),
  );
  if k == 0 {
    e = ahalf(c, s246, (c + p.tap(y, x, -(2), 0)));
  } else {
    if k == 1 {
      if (p.tap(y, x, 0, 5) - c).abs() <= (p.tap(y, x, 0, -(3)) - c).abs() {
        (w, reg) = (H3, Q);
      } else {
        (w, reg) = (Q, H3);
      }
      e = dir2(
        c,
        (p.tap(y, x, 0, 4) - p.tap(y, x, 0, 5)),
        w,
        (s248 - p.tap(y, x, 0, -(3))),
        reg,
      );
    } else {
      if k == 2 {
        e = (c + ((((s246 + s250) - p.tap(y, x, 0, -(1))) - p.tap(y, x, 0, 2)) * HALF));
      } else {
        if k == 3 {
          e = lin2(p.tap(y, x, -(2), -(2)), Q, s250, H3);
        } else {
          e = (((s250 * Q) + (s246 * HALF)) + ((s248 + s255) * EIGHTH));
        }
      }
    }
  }
  e2 = clamp4(e, s246, s250, s248, s255);
  (e1, e2)
}
fn mode8(p: &Plane, y: usize, x: usize, k: u8) -> (f32, f32) {
  let mut c: f32;
  let mut e: f32;
  let mut e1: f32;
  let mut e2: f32;
  let mut reg: f32;
  let mut s218: f32;
  let mut s246: f32;
  let mut s248: f32;
  let mut s250: f32;
  let mut v216: f32;
  let mut v246: f32;
  let mut v248: f32;
  let mut v250: f32;
  let mut w: f32;
  c = p.tap(y, x, 0, 0);
  (v246, v250, v248, v216) = (
    p.tap(y, x, 2, 0),
    p.tap(y, x, 1, 2),
    p.tap(y, x, 0, -(1)),
    p.tap(y, x, -(1), 1),
  );
  if k == 0 {
    if (p.tap(y, x, -(5), 0) - c).abs() <= (p.tap(y, x, 3, 0) - c).abs() {
      (w, reg) = (Q, H3);
    } else {
      (w, reg) = (H3, Q);
    }
    e = dir2(
      c,
      (p.tap(y, x, -(4), 0) - p.tap(y, x, -(5), 0)),
      reg,
      (v246 - p.tap(y, x, 3, 0)),
      w,
    );
  } else {
    if k == 1 {
      e = ahalf(c, v248, (c + p.tap(y, x, 0, -(2))));
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, 2, -(2)), Q, v216, H3);
      } else {
        if k == 3 {
          e = (c + ((((v248 + v216) - p.tap(y, x, 1, 0)) - p.tap(y, x, -(2), 0)) * HALF));
        } else {
          e = (((v216 * Q) + (v248 * HALF)) + ((v246 + v250) * EIGHTH));
        }
      }
    }
  }
  e1 = clamp4(e, v248, v216, v246, v250);
  (s248, s218, s246, s250) = (
    p.tap(y, x, 0, 2),
    p.tap(y, x, 2, 1),
    p.tap(y, x, -(1), 0),
    p.tap(y, x, 1, -(1)),
  );
  if k == 0 {
    e = ahalf(c, s246, (c + p.tap(y, x, -(2), 0)));
  } else {
    if k == 1 {
      if (p.tap(y, x, 0, -(5)) - c).abs() <= (p.tap(y, x, 0, 3) - c).abs() {
        (w, reg) = (H3, Q);
      } else {
        (w, reg) = (Q, H3);
      }
      e = dir2(
        c,
        (p.tap(y, x, 0, -(4)) - p.tap(y, x, 0, -(5))),
        w,
        (s248 - p.tap(y, x, 0, 3)),
        reg,
      );
    } else {
      if k == 2 {
        e = lin2(p.tap(y, x, -(2), 2), Q, s250, H3);
      } else {
        if k == 3 {
          e = (c + ((((s246 + s250) - p.tap(y, x, 0, 1)) - p.tap(y, x, 0, -(2))) * HALF));
        } else {
          e = (((s250 * Q) + (s246 * HALF)) + ((s248 + s218) * EIGHTH));
        }
      }
    }
  }
  e2 = clamp4(e, s246, s250, s248, s218);
  (e1, e2)
}

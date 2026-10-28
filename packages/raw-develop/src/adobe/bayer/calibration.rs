//! Sony's per-body daylight calibration for Adobe's Bayer pre-gain.
//!
//! The per-file daylight white balance is in the encrypted SR2SubIFD (tag
//! `0x7820`), reached through IFD0's `DNGPrivateData` (`0xc634`) pointer. The
//! reversible word cipher and tag layout are documented by ExifTool's Sony.pm.
//! Camera reference daylight ratios and the [0.8,1.25] acceptance range follow
//! Adobe18.7's `ReadSonySR2`/`ReadSony3x0`. Its `SetCameraCalibration` rounds the
//! accepted diagonal entries to four decimal places before the colour pipeline.

use crate::error::{Error, Result};
use crate::tiff::{Endian, Ifd, TiffReader};

/// Read the SR2 daylight R/G/B levels without retaining or copying the RAW data.
/// A file with no SR2 metadata returns `None`; malformed offsets are rejected.
pub(crate) fn read_daylight(t: &TiffReader<'_>, ifd0: &Ifd) -> Result<Option<[f64; 3]>> {
  let Some(pointer) = ifd0.get(0xc634) else {
    return Ok(None);
  };
  if !matches!((pointer.typ, pointer.count), (1 | 7, 4) | (4, 1)) {
    return Err(Error::Malformed(
      "ARW: invalid SR2 private IFD pointer".into(),
    ));
  }
  let pointer = pointer.field;
  let private_offset = match t.endian {
    Endian::Little => u32::from_le_bytes(pointer),
    Endian::Big => u32::from_be_bytes(pointer),
  } as usize;
  let private = t.ifd(private_offset)?;
  let scalar = |tag| -> Result<Option<u32>> {
    private
      .get(tag)
      .map(|e| {
        if e.typ != 4 || e.count != 1 {
          return Err(Error::Malformed("ARW: invalid SR2 block descriptor".into()));
        }
        e.value_u32(t, 0)
      })
      .transpose()
  };
  let (Some(offset), Some(length), Some(key)) =
    (scalar(0x7200)?, scalar(0x7201)?, private.get(0x7221))
  else {
    return Ok(None);
  };
  // Sony stores the key as four UNDEFINED bytes, not as a TIFF scalar. Reading
  // its first element would retain only one byte of the key.
  if !matches!((key.typ, key.count), (1 | 7, 4) | (4, 1)) {
    return Err(Error::Malformed("ARW: invalid SR2 encryption key".into()));
  }
  let key = key.field;
  let key = match t.endian {
    Endian::Little => u32::from_le_bytes(key),
    Endian::Big => u32::from_be_bytes(key),
  };
  // This is metadata, normally about36KiB. Bound its owned allocation before
  // decoding so an invalid metadata tag cannot request another RAW-sized buffer.
  if length > 16 * 1024 * 1024 {
    return Err(Error::Malformed(
      "ARW: oversized encrypted SR2 metadata".into(),
    ));
  }
  let offset = offset as usize;
  let mut decrypted = t.bytes(offset, length as usize)?.to_vec();
  decrypt(&mut decrypted, key);
  let sr2 = TiffReader::with_endian(&decrypted, t.endian);
  let sub = sr2.ifd(0)?;
  let Some(entry) = sub.get(0x7820) else {
    return Ok(None);
  };
  if entry.typ != 8 || entry.count != 3 {
    return Err(Error::Malformed(
      "ARW: invalid SR2 daylight white balance".into(),
    ));
  }
  // Payload offsets in the decrypted IFD are absolute file offsets. Convert just
  // the selected entry to the small decrypted buffer's coordinate system.
  let absolute = match t.endian {
    Endian::Little => u32::from_le_bytes(entry.field),
    Endian::Big => u32::from_be_bytes(entry.field),
  };
  let relative = (absolute as usize)
    .checked_sub(offset)
    .and_then(|v| u32::try_from(v).ok())
    .ok_or_else(|| Error::Malformed("ARW: SR2 daylight offset precedes metadata".into()))?;
  let mut entry = entry.clone();
  entry.field = match t.endian {
    Endian::Little => relative.to_le_bytes(),
    Endian::Big => relative.to_be_bytes(),
  };
  let values = entry.values_f64(&sr2)?;
  let levels = [values[0], values[1], values[2]];
  Ok(
    levels
      .iter()
      .all(|v| v.is_finite() && *v > 0.0)
      .then_some(levels),
  )
}

/// Adobe's per-body diagonal camera calibration for the supported Sony models.
/// Out-of-range or absent camera metadata gives the identity calibration, as in
/// the reference reader. This calibration is independent of as-shot WB.
pub(crate) fn camera_calibration(model: &str, daylight: Option<[f64; 3]>) -> [f64; 3] {
  let Some(levels) = daylight.filter(|v| v.iter().all(|x| x.is_finite() && *x > 0.0)) else {
    return [1.0; 3];
  };
  let reference = match model.trim() {
    "ILCE-1M2" => [2127.0 / 1024.0, 1653.0 / 1024.0],
    "ILCE-7CR" | "ILCE-7RM5" => [2423.0 / 1024.0, 1799.0 / 1024.0],
    _ => return [1.0; 3],
  };
  let r = reference[0] / (levels[0] / levels[1]);
  let b = reference[1] / (levels[2] / levels[1]);
  if (0.8..=1.25).contains(&r) && (0.8..=1.25).contains(&b) {
    [r, 1.0, b].map(|v| (v * 10000.0).round() * 0.0001)
  } else {
    [1.0; 3]
  }
}

fn decrypt(data: &mut [u8], mut key: u32) {
  let mut pad = [0u32; 128];
  for value in &mut pad[..4] {
    key = key.wrapping_mul(0x02e9_0edd).wrapping_add(1);
    *value = key;
  }
  pad[3] = (pad[3] << 1) | ((pad[0] ^ pad[2]) >> 31);
  for i in 4..127 {
    pad[i] = ((pad[i - 4] ^ pad[i - 2]) << 1) | ((pad[i - 3] ^ pad[i - 1]) >> 31);
  }
  for (j, bytes) in data.chunks_exact_mut(4).enumerate() {
    let i = j + 127;
    pad[i & 127] = pad[(i + 1) & 127] ^ pad[(i + 65) & 127];
    let word = u32::from_be_bytes(bytes.try_into().unwrap()) ^ pad[i & 127];
    bytes.copy_from_slice(&word.to_be_bytes());
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn per_body_calibration_matches_the_original_arw_pipeline() {
    let a = camera_calibration("ILCE-1M2", Some([2156., 1024., 1800.]));
    let b = camera_calibration("ILCE-1M2", Some([2154., 1024., 1817.]));
    let rounded = |v: [f64; 3]| v.map(|x| (x * 10000.0).round() * 0.0001);
    assert_eq!(a, rounded([0.9865, 1., 0.9183]));
    assert_eq!(b, rounded([0.9875, 1., 0.9097]));
    assert_eq!(
      camera_calibration("ILCE-7CR", Some([2613., 1024., 1767.])),
      rounded([0.9273, 1., 1.0181])
    );
    assert_eq!(
      camera_calibration("ILCE-7RM5", Some([2535., 1024., 1779.])),
      rounded([0.9558, 1., 1.0112])
    );
  }

  #[test]
  fn calibration_rejects_invalid_or_unreasonable_levels() {
    assert_eq!(camera_calibration("ILCE-1M2", None), [1.; 3]);
    assert_eq!(
      camera_calibration("ILCE-1M2", Some([0., 1024., 1800.])),
      [1.; 3]
    );
    assert_eq!(
      camera_calibration("ILCE-1M2", Some([9000., 1024., 1800.])),
      [1.; 3]
    );
  }

  #[test]
  fn encrypted_private_ifd_reads_daylight_levels() {
    // Minimal original-TIFF-style structure, with absolute offsets inside the
    // encrypted SR2SubIFD. Encryption is its own inverse.
    let mut data = vec![0u8; 128];
    data[..8].copy_from_slice(&[b'I', b'I', 42, 0, 8, 0, 0, 0]);
    data[8..10].copy_from_slice(&1u16.to_le_bytes());
    data[10..22].copy_from_slice(&[0x34, 0xc6, 1, 0, 4, 0, 0, 0, 32, 0, 0, 0]);
    data[32..34].copy_from_slice(&3u16.to_le_bytes());
    for (i, (tag, value)) in [(0x7200u16, 80u32), (0x7201, 48), (0x7221, 0x44332211)]
      .into_iter()
      .enumerate()
    {
      let p = 34 + i * 12;
      data[p..p + 2].copy_from_slice(&tag.to_le_bytes());
      let (typ, count) = if tag == 0x7221 { (7u16, 4u32) } else { (4, 1) };
      data[p + 2..p + 4].copy_from_slice(&typ.to_le_bytes());
      data[p + 4..p + 8].copy_from_slice(&count.to_le_bytes());
      data[p + 8..p + 12].copy_from_slice(&value.to_le_bytes());
    }
    data[80..82].copy_from_slice(&1u16.to_le_bytes());
    data[82..94].copy_from_slice(&[0x20, 0x78, 8, 0, 3, 0, 0, 0, 104, 0, 0, 0]);
    for (i, v) in [2156u16, 1024, 1800].into_iter().enumerate() {
      data[104 + 2 * i..106 + 2 * i].copy_from_slice(&v.to_le_bytes());
    }
    decrypt(&mut data[80..128], 0x44332211);
    let t = TiffReader::new(&data).unwrap();
    let ifd0 = t.ifd(8).unwrap();
    assert_eq!(
      read_daylight(&t, &ifd0).unwrap(),
      Some([2156., 1024., 1800.])
    );
  }
}

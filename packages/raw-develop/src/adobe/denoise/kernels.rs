use super::{Buffer, Cancel, Op, Result};
use rayon::prelude::*;

// Small independent spatial blocks bound im2col scratch and cancellation latency.
const PIXELS_PER_BLOCK: usize = 128;

pub(super) fn convolve(
  input: &Buffer,
  shape: [usize; 3],
  op: &Op,
  parameters: &[f32],
  cancel: &Cancel,
) -> Result<Buffer> {
  let Op::Conv2d {
    in_channels,
    out_channels,
    groups,
    kernel,
    stride,
    padding,
    weights,
    bias,
  } = *op
  else {
    unreachable!()
  };
  let [_, ih, iw] = input.shape;
  let [_, oh, ow] = shape;
  let ic = in_channels / groups;
  let oc = out_channels / groups;
  let k = ic * kernel[0] * kernel[1];
  let w = &parameters[weights.offset..weights.offset + weights.count];
  let bias = &parameters[bias.offset..bias.offset + bias.count];
  let direct = kernel == [1, 1] && stride == [1, 1] && padding == [0; 4] && groups == 1;
  let mut output = vec![0.0; out_channels * oh * ow];
  output
    .par_chunks_mut(PIXELS_PER_BLOCK * out_channels)
    .enumerate()
    .try_for_each(|(block, dst)| {
      cancel.check()?;
      let begin = block * PIXELS_PER_BLOCK;
      let pixels = dst.len() / out_channels;
      let mut patch = if direct {
        Vec::new()
      } else {
        vec![0.0; pixels * k]
      };
      for group in 0..groups {
        cancel.check()?;
        let a = if direct {
          &input.data[begin * in_channels..(begin + pixels) * in_channels]
        } else {
          for p in 0..pixels {
            let y = ((begin + p) / ow) * stride[0];
            let x = ((begin + p) % ow) * stride[1];
            for c in 0..ic {
              for ky in 0..kernel[0] {
                for kx in 0..kernel[1] {
                  let sy = (y + ky).checked_sub(padding[0]);
                  let sx = (x + kx).checked_sub(padding[2]);
                  let v = match (sy, sx) {
                    (Some(y), Some(x)) if y < ih && x < iw => {
                      input.data[(y * iw + x) * in_channels + group * ic + c]
                    }
                    _ => 0.0,
                  };
                  patch[p * k + (c * kernel[0] + ky) * kernel[1] + kx] = v;
                }
              }
            }
          }
          &patch
        };
        // A: pixels x K row-major; B: transpose of OIHW weights (K x oc).
        // C: pixels x oc, with full-channel row stride. Validation guarantees
        // every read is in bounds and the mutable spatial blocks never overlap.
        unsafe {
          matrixmultiply::sgemm(
            pixels,
            k,
            oc,
            1.0,
            a.as_ptr(),
            k as isize,
            1,
            w.as_ptr().add(group * oc * k),
            1,
            k as isize,
            0.0,
            dst.as_mut_ptr().add(group * oc),
            out_channels as isize,
            1,
          );
        }
      }
      for pixel in dst.chunks_exact_mut(out_channels) {
        for (v, b) in pixel.iter_mut().zip(bias) {
          *v += *b;
        }
      }
      Ok::<_, crate::Error>(())
    })?;
  Ok(Buffer::new(shape, output))
}

pub(super) fn upsample(input: &Buffer, shape: [usize; 3], cancel: &Cancel) -> Result<Buffer> {
  let [c, h, w] = shape;
  let iw = input.shape[2];
  let mut data = vec![0.0; c * h * w];
  data
    .par_chunks_mut(w * c)
    .enumerate()
    .try_for_each(|(y, row)| {
      cancel.check()?;
      for (x, pixel) in row.chunks_mut(c).enumerate() {
        let start = ((y / 2) * iw + x / 2) * c;
        pixel.copy_from_slice(&input.data[start..start + c]);
      }
      Ok::<_, crate::Error>(())
    })?;
  Ok(Buffer::new(shape, data))
}

pub(super) fn slice(
  input: &Buffer,
  shape: [usize; 3],
  axis: usize,
  start: usize,
  cancel: &Cancel,
) -> Result<Buffer> {
  let [c, h, w] = shape;
  let [_, _, iw] = input.shape;
  let mut data = vec![0.0; c * h * w];
  data
    .par_chunks_mut(w * c)
    .enumerate()
    .try_for_each(|(y, row)| {
      cancel.check()?;
      let sy = y + if axis == 1 { start } else { 0 };
      let sx = if axis == 2 { start } else { 0 };
      let offset = (sy * iw + sx) * c;
      row.copy_from_slice(&input.data[offset..offset + row.len()]);
      Ok::<_, crate::Error>(())
    })?;
  Ok(Buffer::new(shape, data))
}

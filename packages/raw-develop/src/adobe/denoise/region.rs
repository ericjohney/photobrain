//! Assemble regions from the fixed full-image model grid, retaining bounded tiles.
//! Histogram-dependent baseline tiles must never be re-anchored to an arbitrary ROI.
use super::{
  Tensor, Variant,
  format::elements,
  invalid,
  tiles::{Rect, TileGeometry},
};
use crate::{Cancel, Result};
use std::collections::VecDeque;

pub(super) struct TileCache {
  bounds: Rect,
  edge: i32,
  capacity: usize,
  tiles: VecDeque<(Rect, Tensor)>,
}

impl TileCache {
  pub(super) fn new(bounds: Rect, variant: Variant, capacity: usize) -> Result<Self> {
    if capacity == 0 || capacity > 64 {
      return Err(invalid("tile cache capacity must be 1..64"));
    }
    Ok(Self {
      bounds,
      edge: TileGeometry::max_pipe_edge(variant),
      capacity,
      tiles: VecDeque::new(),
    })
  }

  /// Return a region with nearest-pixel repetition outside the image. The caller
  /// chooses this edge policy only for stages whose native boundary is verified.
  pub(super) fn read_repeated(
    &mut self,
    area: Rect,
    cancel: &Cancel,
    mut render: impl FnMut(Rect) -> Result<Tensor>,
  ) -> Result<Tensor> {
    cancel.check()?;
    let [height, width] = area.size();
    let mut output = vec![f32::NAN; elements([3, height, width])?];
    let bounds = self.bounds;
    let clamp_y = |v: i32| v.clamp(bounds.top(), bounds.bottom() - 1);
    let clamp_x = |v: i32| v.clamp(bounds.left(), bounds.right() - 1);
    let first_y = (clamp_y(area.top()) - bounds.top()) / self.edge;
    let last_y = (clamp_y(area.bottom() - 1) - bounds.top()) / self.edge;
    let first_x = (clamp_x(area.left()) - bounds.left()) / self.edge;
    let last_x = (clamp_x(area.right() - 1) - bounds.left()) / self.edge;
    for ty in first_y..=last_y {
      for tx in first_x..=last_x {
        cancel.check()?;
        let top = bounds.top() + ty * self.edge;
        let left = bounds.left() + tx * self.edge;
        let tile = Rect::new(
          top,
          left,
          (i64::from(top) + i64::from(self.edge)).min(i64::from(bounds.bottom())) as i32,
          (i64::from(left) + i64::from(self.edge)).min(i64::from(bounds.right())) as i32,
        )?;
        if let Some(index) = self.tiles.iter().position(|(rect, _)| *rect == tile) {
          let entry = self.tiles.remove(index).unwrap();
          self.tiles.push_back(entry);
        } else {
          let tensor = render(tile)?;
          let [h, w] = tile.size();
          if tensor.shape() != [3, h, w] {
            return Err(invalid("tile provider returned wrong RGB shape"));
          }
          if self.tiles.len() == self.capacity {
            self.tiles.pop_front();
          }
          self.tiles.push_back((tile, tensor));
        }
        let source = &self.tiles.back().unwrap().1;
        let [h, w] = tile.size();
        let y0 = if tile.top() == bounds.top() {
          area.top()
        } else {
          area.top().max(tile.top())
        };
        let x0 = if tile.left() == bounds.left() {
          area.left()
        } else {
          area.left().max(tile.left())
        };
        let y1 = if tile.bottom() == bounds.bottom() {
          area.bottom()
        } else {
          area.bottom().min(tile.bottom())
        };
        let x1 = if tile.right() == bounds.right() {
          area.right()
        } else {
          area.right().min(tile.right())
        };
        for y in y0..y1 {
          cancel.check()?;
          for x in x0..x1 {
            let src = (clamp_y(y) - tile.top()) as usize * w + (clamp_x(x) - tile.left()) as usize;
            let dst = (y - area.top()) as usize * width + (x - area.left()) as usize;
            for c in 0..3 {
              output[c * height * width + dst] = source.data()[c * h * w + src];
            }
          }
        }
      }
    }
    Tensor::new([3, height, width], output)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn global_tile_grid_seams_edges_and_reuse() {
    let bounds = Rect::new(-7, 11, 924, 943).unwrap();
    let mut cache = TileCache::new(bounds, Variant::XtransDetails, 9).unwrap();
    let mut calls = Vec::new();
    let render = |tile: Rect, calls: &mut Vec<Rect>| {
      calls.push(tile);
      let [h, w] = tile.size();
      let mut data = Vec::new();
      for c in 0..3 {
        for y in tile.top()..tile.bottom() {
          for x in tile.left()..tile.right() {
            data.push((c * 10000000 + (y - bounds.top()) * 10000 + x - bounds.left()) as f32);
          }
        }
      }
      Tensor::new([3, h, w], data)
    };
    for area in [
      Rect::new(455, 473, 462, 480).unwrap(),
      Rect::new(-10, 8, -3, 15).unwrap(),
      Rect::new(920, 939, 927, 946).unwrap(),
    ] {
      let output = cache
        .read_repeated(area, &Cancel::never(), |r| render(r, &mut calls))
        .unwrap();
      let [h, w] = area.size();
      for c in 0..3 {
        for y in 0..h {
          for x in 0..w {
            let sy =
              (area.top() + y as i32).clamp(bounds.top(), bounds.bottom() - 1) - bounds.top();
            let sx =
              (area.left() + x as i32).clamp(bounds.left(), bounds.right() - 1) - bounds.left();
            assert_eq!(
              output.data()[(c * h + y) * w + x],
              (c as i32 * 10000000 + sy * 10000 + sx) as f32
            );
          }
        }
      }
      cache
        .read_repeated(area, &Cancel::never(), |_| {
          panic!("cached region rerendered")
        })
        .unwrap();
    }
    assert!(
      calls
        .iter()
        .all(|r| (r.top() - bounds.top()) % 465 == 0 && (r.left() - bounds.left()) % 465 == 0)
    );
  }
  #[test]
  fn provider_failure_shape_and_cancellation_do_not_cache_bad_tiles() {
    let bounds = Rect::new(0, 0, 6, 6).unwrap();
    let mut cache = TileCache::new(bounds, Variant::Bayer, 1).unwrap();
    assert!(
      cache
        .read_repeated(bounds, &Cancel::never(), |_| Err(invalid(
          "provider failure"
        )))
        .is_err()
    );
    assert!(
      cache
        .read_repeated(bounds, &Cancel::never(), |_| Tensor::new(
          [1, 6, 6],
          vec![0.0; 36]
        ))
        .is_err()
    );
    assert!(cache.tiles.is_empty());
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
      cache.read_repeated(bounds, &cancel, |_| panic!()),
      Err(crate::Error::Cancelled)
    ));
  }
}

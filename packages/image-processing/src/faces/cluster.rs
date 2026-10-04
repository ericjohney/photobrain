//! Chaining-resistant face clustering: average-linkage agglomeration restricted to the
//! mutual k-nearest-neighbour graph.
//!
//! 1. Candidates: each vector ranks its `CANDIDATE_NEIGHBORS` most similar others with
//!    cosine >= threshold (ties by lower index). A pair is an edge only when each is in
//!    the other's list (mutual kNN), so a hub or chain point that many faces like, but
//!    that prefers its own neighbours, connects to nobody's group.
//! 2. Agglomeration: starting from singletons, repeatedly merge the pair of groups
//!    joined by at least one edge with the highest *average* pairwise cosine, while that
//!    average is >= threshold. For unit vectors the average over all cross pairs is
//!    exactly `sum(A) . sum(B) / (|A| |B|)`, so each group carries only its vector sum.
//!
//! Single linkage lets a chain of pairwise-similar faces fuse two people; here a chain
//! point can at most join one side, and two groups merge only when their members are
//! similar on average. Output is a pure function of the input: candidate rows are
//! computed in fixed blocks, and merges follow a total order (higher average first,
//! then the lower group ids).

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use rayon::prelude::*;

/// Ranked neighbours per vector. Enough to keep large same-person groups connected by
/// mutual edges; the linkage criterion, not this bound, decides merges.
pub(crate) const CANDIDATE_NEIGHBORS: usize = 32;

/// Rows per similarity block: `ROW_BLOCK * n` floats of scratch per worker.
const ROW_BLOCK: usize = 64;

/// Groups of indices into the `embeddings.len() / dimension` vectors, each of size >=
/// `min_size` with ascending members, ordered by their smallest member.
pub(crate) fn cluster(
  embeddings: &[f32],
  dimension: usize,
  threshold: f32,
  min_size: usize,
) -> Result<Vec<Vec<u32>>, String> {
  if dimension == 0 {
    return Err("dimension must be positive".to_string());
  }
  if !embeddings.len().is_multiple_of(dimension) {
    return Err(format!(
      "embeddings length {} is not a multiple of dimension {dimension}",
      embeddings.len()
    ));
  }
  if !threshold.is_finite() {
    return Err("threshold must be finite".to_string());
  }
  let n = embeddings.len() / dimension;
  if n > u32::MAX as usize {
    return Err("too many embeddings".to_string());
  }
  let unit = normalized(embeddings, dimension);
  let candidates = candidate_lists(&unit, n, dimension, threshold, CANDIDATE_NEIGHBORS);
  Ok(average_linkage(
    &unit,
    dimension,
    &candidates,
    f64::from(threshold),
    min_size.max(1),
  ))
}

/// Unit-length copies. Zero or non-finite vectors become NaN so every similarity that
/// involves them is NaN and fails the threshold comparison: they never join a group.
fn normalized(embeddings: &[f32], dimension: usize) -> Vec<f32> {
  let mut unit = embeddings.to_vec();
  for row in unit.chunks_exact_mut(dimension) {
    let norm = row.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm.is_finite() && norm > 0.0 {
      row.iter_mut().for_each(|v| *v /= norm);
    } else {
      row.fill(f32::NAN);
    }
  }
  unit
}

/// For each vector, its top-`k` others with similarity >= `threshold`, ranked by
/// similarity descending then index ascending.
fn candidate_lists(
  unit: &[f32],
  n: usize,
  dimension: usize,
  threshold: f32,
  k: usize,
) -> Vec<Vec<u32>> {
  (0..n.div_ceil(ROW_BLOCK))
    .into_par_iter()
    .flat_map_iter(|block| {
      let start = block * ROW_BLOCK;
      let rows = ROW_BLOCK.min(n - start);
      let mut sims = vec![0f32; rows * n];
      // SAFETY: `unit` holds `n * dimension` floats. A is the `rows x dimension` block
      // starting at row `start`, B is `unit` read as its `dimension x n` transpose, and
      // C is the `rows x n` buffer above; strides are in elements and stay in bounds.
      unsafe {
        matrixmultiply::sgemm(
          rows,
          dimension,
          n,
          1.0,
          unit.as_ptr().add(start * dimension),
          dimension as isize,
          1,
          unit.as_ptr(),
          1,
          dimension as isize,
          0.0,
          sims.as_mut_ptr(),
          n as isize,
          1,
        );
      }
      sims
        .chunks_exact(n)
        .enumerate()
        .map(|(offset, row)| top_k(row, start + offset, threshold, k))
        .collect::<Vec<_>>()
    })
    .collect()
}

fn top_k(row: &[f32], own: usize, threshold: f32, k: usize) -> Vec<u32> {
  // Sorted best-first: higher similarity, then lower index.
  let mut best: Vec<(f32, u32)> = Vec::with_capacity(k + 1);
  for (j, &sim) in row.iter().enumerate() {
    if j == own || sim.is_nan() || sim < threshold {
      continue;
    }
    if best.len() == k && sim <= best[k - 1].0 {
      // An equal similarity loses to the lower index already kept.
      continue;
    }
    let at = best.partition_point(|&(s, _)| s >= sim);
    best.insert(at, (sim, j as u32));
    best.truncate(k);
  }
  best.into_iter().map(|(_, j)| j).collect()
}

/// A potential merge of groups `a < b`, valid while both still have the recorded
/// versions.
struct Merge {
  average: f64,
  a: u32,
  b: u32,
  versions: (u32, u32),
}

impl PartialEq for Merge {
  fn eq(&self, other: &Self) -> bool {
    self.cmp(other) == Ordering::Equal
  }
}
impl Eq for Merge {}
impl PartialOrd for Merge {
  fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
    Some(self.cmp(other))
  }
}
impl Ord for Merge {
  /// Max-heap order: higher average first, then lower `(a, b)`.
  fn cmp(&self, other: &Self) -> Ordering {
    self
      .average
      .total_cmp(&other.average)
      .then_with(|| other.a.cmp(&self.a))
      .then_with(|| other.b.cmp(&self.b))
  }
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
  while parent[x as usize] != x {
    parent[x as usize] = parent[parent[x as usize] as usize];
    x = parent[x as usize];
  }
  x
}

fn average_linkage(
  unit: &[f32],
  dimension: usize,
  candidates: &[Vec<u32>],
  threshold: f64,
  min_size: usize,
) -> Vec<Vec<u32>> {
  let n = candidates.len();
  // Mutual-kNN adjacency (ascending). Entries may later name merged-away groups; they
  // are resolved through `parent` when a group's neighbourhood is rebuilt.
  let sorted: Vec<Vec<u32>> = candidates
    .iter()
    .map(|list| {
      let mut list = list.clone();
      list.sort_unstable();
      list
    })
    .collect();
  let mut adjacency: Vec<Vec<u32>> = sorted
    .iter()
    .enumerate()
    .map(|(i, list)| {
      list
        .iter()
        .copied()
        .filter(|&j| sorted[j as usize].binary_search(&(i as u32)).is_ok())
        .collect()
    })
    .collect();
  drop(sorted);
  let mut sums: Vec<f64> = unit.iter().map(|&v| f64::from(v)).collect();
  let mut sizes = vec![1u32; n];
  let mut versions = vec![0u32; n];
  let mut parent: Vec<u32> = (0..n as u32).collect();
  let span = |g: u32| g as usize * dimension..(g as usize + 1) * dimension;
  let average = |sums: &[f64], sizes: &[u32], a: u32, b: u32| -> f64 {
    let dot: f64 = sums[span(a)]
      .iter()
      .zip(&sums[span(b)])
      .map(|(x, y)| x * y)
      .sum();
    dot / (f64::from(sizes[a as usize]) * f64::from(sizes[b as usize]))
  };

  let mut heap = BinaryHeap::new();
  for (i, list) in adjacency.iter().enumerate() {
    for &j in list.iter().filter(|&&j| j as usize > i) {
      let value = average(&sums, &sizes, i as u32, j);
      if value >= threshold {
        heap.push(Merge {
          average: value,
          a: i as u32,
          b: j,
          versions: (0, 0),
        });
      }
    }
  }

  while let Some(Merge {
    a,
    b,
    versions: (va, vb),
    ..
  }) = heap.pop()
  {
    if parent[a as usize] != a
      || parent[b as usize] != b
      || versions[a as usize] != va
      || versions[b as usize] != vb
    {
      continue;
    }
    // `a < b`: the lower id survives, so roots stay each group's smallest member.
    parent[b as usize] = a;
    sizes[a as usize] += sizes[b as usize];
    versions[a as usize] += 1;
    let (head, tail) = sums.split_at_mut(b as usize * dimension);
    head[span(a)]
      .iter_mut()
      .zip(&tail[..dimension])
      .for_each(|(x, y)| *x += y);

    let mut neighbors = std::mem::take(&mut adjacency[a as usize]);
    neighbors.append(&mut adjacency[b as usize]);
    for neighbor in &mut neighbors {
      *neighbor = find(&mut parent, *neighbor);
    }
    neighbors.sort_unstable();
    neighbors.dedup();
    neighbors.retain(|&g| g != a);
    for &g in &neighbors {
      let value = average(&sums, &sizes, a, g);
      if value >= threshold {
        let (lo, hi) = (a.min(g), a.max(g));
        heap.push(Merge {
          average: value,
          a: lo,
          b: hi,
          versions: (versions[lo as usize], versions[hi as usize]),
        });
      }
    }
    adjacency[a as usize] = neighbors;
  }

  let mut groups: Vec<Vec<u32>> = vec![Vec::new(); n];
  for i in 0..n as u32 {
    let root = find(&mut parent, i);
    groups[root as usize].push(i);
  }
  // Each root is its group's smallest member, so index order is the output order, and
  // members were pushed in ascending order.
  groups.retain(|group| group.len() >= min_size);
  groups
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Deterministic xorshift for test vectors.
  struct Rng(u64);
  impl Rng {
    fn next(&mut self) -> f32 {
      self.0 ^= self.0 << 13;
      self.0 ^= self.0 >> 7;
      self.0 ^= self.0 << 17;
      ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
    fn vector(&mut self, dimension: usize) -> Vec<f32> {
      let v: Vec<f32> = (0..dimension).map(|_| self.next()).collect();
      unit(v)
    }
  }

  fn unit(v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.into_iter().map(|x| x / norm).collect()
  }

  fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
  }

  /// `normalize((1 - t) center + t noise)`; for `t = 0.45` in high dimension, members
  /// have cosine ~0.6 with each other, like same-person SFace embeddings.
  fn jitter(rng: &mut Rng, center: &[f32], t: f32) -> Vec<f32> {
    let noise = rng.vector(center.len());
    unit(
      center
        .iter()
        .zip(&noise)
        .map(|(c, e)| c * (1.0 - t) + e * t)
        .collect(),
    )
  }

  #[test]
  fn chain_between_two_tight_clusters_does_not_merge_them() {
    let dimension = 32;
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let a = rng.vector(dimension);
    let b = {
      let raw = rng.vector(dimension);
      let along = dot(&raw, &a);
      unit(raw.iter().zip(&a).map(|(x, y)| x - along * y).collect())
    };
    let mut data = Vec::new();
    for _ in 0..15 {
      data.extend(jitter(&mut rng, &a, 0.08));
    }
    for _ in 0..15 {
      data.extend(jitter(&mut rng, &b, 0.08));
    }
    // Chain points at 22.5, 45 and 67.5 degrees from `a` towards the orthogonal `b`.
    let chain: Vec<Vec<f32>> = (1..4)
      .map(|step| {
        let angle = std::f32::consts::FRAC_PI_8 * step as f32;
        a.iter()
          .zip(&b)
          .map(|(x, y)| x * angle.cos() + y * angle.sin())
          .collect()
      })
      .collect();
    chain.iter().for_each(|point| data.extend(point));
    let threshold = 0.6;
    // Precondition: every hop of the chain, and its ends to the clusters, clears the
    // threshold, so single linkage would join everything.
    assert!(dot(&chain[0], &chain[1]) >= threshold && dot(&chain[1], &chain[2]) >= threshold);
    assert!(dot(&data[..dimension], &chain[0]) >= threshold);
    assert!(dot(&data[15 * dimension..16 * dimension], &chain[2]) >= threshold);

    let groups = cluster(&data, dimension, threshold, 3).unwrap();
    let a_group = groups.iter().find(|g| g.contains(&0)).unwrap();
    let b_group = groups.iter().find(|g| g.contains(&15)).unwrap();
    assert_ne!(a_group, b_group, "{groups:?}");
    assert!((0..15).all(|i| a_group.contains(&i)), "{groups:?}");
    assert!((15..30).all(|i| b_group.contains(&i)), "{groups:?}");
  }

  #[test]
  fn recovers_planted_clusters_among_random_vectors() {
    let dimension = 128;
    let mut rng = Rng(0xfeed);
    let centers: Vec<Vec<f32>> = (0..20).map(|_| rng.vector(dimension)).collect();
    let mut data = Vec::new();
    let mut labels = Vec::new();
    for i in 0..1500 {
      if i % 3 == 0 {
        let person = (i / 3) % 20;
        data.extend(jitter(&mut rng, &centers[person], 0.45));
        labels.push(Some(person));
      } else {
        data.extend(rng.vector(dimension));
        labels.push(None);
      }
    }
    let groups = cluster(&data, dimension, 0.48, 3).unwrap();
    assert_eq!(groups.len(), 20, "{groups:?}");
    for group in &groups {
      let person = labels[group[0] as usize].unwrap();
      assert!(group.iter().all(|&i| labels[i as usize] == Some(person)));
      assert_eq!(group.len(), 25);
    }
  }

  #[test]
  fn output_is_sorted_and_deterministic_across_pool_sizes() {
    let dimension = 16;
    let mut rng = Rng(42);
    let centers: Vec<Vec<f32>> = (0..5).map(|_| rng.vector(dimension)).collect();
    let mut data = Vec::new();
    for i in 0..300 {
      data.extend(jitter(&mut rng, &centers[i % 5], 0.2));
    }
    let first = cluster(&data, dimension, 0.7, 3).unwrap();
    assert_eq!(cluster(&data, dimension, 0.7, 3).unwrap(), first);
    for threads in [1, 3] {
      let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .unwrap();
      assert_eq!(
        pool.install(|| cluster(&data, dimension, 0.7, 3).unwrap()),
        first
      );
    }
    assert_eq!(first.len(), 5);
    for (n, group) in first.iter().enumerate() {
      assert!(group.windows(2).all(|w| w[0] < w[1]));
      assert_eq!(group[0] as usize, n, "groups ordered by smallest member");
      assert!(group.iter().all(|&i| i as usize % 5 == n));
      assert_eq!(group.len(), 60);
    }
  }

  #[test]
  fn min_cluster_size_filters_small_groups_and_isolated_points() {
    let dimension = 8;
    let mut rng = Rng(7);
    let (big, small) = (rng.vector(dimension), rng.vector(dimension));
    let mut data = Vec::new();
    for _ in 0..4 {
      data.extend(jitter(&mut rng, &big, 0.05));
    }
    for _ in 0..2 {
      data.extend(jitter(&mut rng, &small, 0.05));
    }
    data.extend(rng.vector(dimension));
    assert_eq!(
      cluster(&data, dimension, 0.9, 3).unwrap(),
      [vec![0, 1, 2, 3]]
    );
    assert_eq!(
      cluster(&data, dimension, 0.9, 2).unwrap(),
      [vec![0, 1, 2, 3], vec![4, 5]]
    );
    let all = cluster(&data, dimension, 0.9, 1).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[2], [6]);
    assert_eq!(cluster(&data, dimension, 0.9, 0).unwrap(), all);
  }

  #[test]
  fn threshold_is_inclusive_and_vectors_are_normalized() {
    // Unnormalized copies of one direction have cosine 1; the zero vector joins nothing.
    let data = [1.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 2.0];
    assert_eq!(cluster(&data, 2, 1.0, 2).unwrap(), [vec![0, 1]]);
    assert_eq!(
      cluster(&data, 2, -1.0, 1).unwrap(),
      [vec![0, 1, 3], vec![2]]
    );
  }

  #[test]
  fn top_k_ranks_by_similarity_then_lower_index() {
    let row = [0.9, 0.5, 0.9, 0.9, 0.95, 0.2];
    assert_eq!(top_k(&row, 1, 0.3, 2), [4, 0]);
    assert_eq!(top_k(&row, 4, 0.3, 2), [0, 2]);
    assert_eq!(top_k(&row, 4, 0.92, 3), Vec::<u32>::new());
    assert_eq!(top_k(&[f32::NAN, 0.5], 5, 0.0, 3), [1]);
  }

  #[test]
  fn rejects_invalid_shapes() {
    assert!(cluster(&[0.0; 5], 2, 0.5, 1).is_err());
    assert!(cluster(&[0.0; 4], 0, 0.5, 1).is_err());
    assert!(cluster(&[0.0; 4], 2, f32::NAN, 1).is_err());
    assert_eq!(cluster(&[], 128, 0.5, 1).unwrap(), Vec::<Vec<u32>>::new());
  }
}

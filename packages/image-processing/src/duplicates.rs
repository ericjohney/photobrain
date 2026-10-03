use std::collections::BTreeMap;

use image_hasher::ImageHash;
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearDuplicateGroup {
  /// Member IDs, ascending.
  pub ids: Vec<i64>,
  /// Largest pairwise Hamming distance between members (may exceed the
  /// threshold because grouping is transitive).
  pub max_distance: u32,
}

/// Group index-aligned `(id, base64 pHash)` pairs into connected components of
/// hashes whose Hamming distance is at most `max_distance`, returning only
/// components with two or more IDs. Hashes that do not decode, or decode to
/// zero or more than 64 bits, are skipped; hashes are only compared with
/// hashes of the same bit length.
///
/// Candidate pairs come from multi-index hashing: each hash is split into
/// `max_distance + 1` disjoint bit ranges and, by pigeonhole, two hashes within
/// `max_distance` agree exactly on at least one range. Only hashes sharing a
/// range value are compared, so random hashes cost far less than all pairs.
#[napi]
pub fn group_near_duplicates(
  ids: Vec<i64>,
  hashes: Vec<String>,
  max_distance: u32,
) -> napi::Result<Vec<NearDuplicateGroup>> {
  if ids.len() != hashes.len() {
    return Err(napi::Error::from_reason(format!(
      "Expected index-aligned ids and hashes, received {} ids and {} hashes",
      ids.len(),
      hashes.len()
    )));
  }
  Ok(group(&ids, &hashes, max_distance))
}

/// Decoded hash packed big-endian into the low bits of a `u64`, with its width.
fn decode(hash: &str) -> Option<(u64, u32)> {
  let decoded = ImageHash::<Box<[u8]>>::from_base64(hash).ok()?;
  let bytes = decoded.as_bytes();
  if bytes.is_empty() || bytes.len() > 8 {
    return None;
  }
  let value = bytes
    .iter()
    .fold(0u64, |value, &byte| (value << 8) | u64::from(byte));
  Some((value, bytes.len() as u32 * 8))
}

fn group(ids: &[i64], hashes: &[String], max_distance: u32) -> Vec<NearDuplicateGroup> {
  let mut by_width: BTreeMap<u32, Vec<(u64, i64)>> = BTreeMap::new();
  for (&id, hash) in ids.iter().zip(hashes) {
    if let Some((value, bits)) = decode(hash) {
      by_width.entry(bits).or_default().push((value, id));
    }
  }
  let mut groups = Vec::new();
  for (bits, entries) in by_width {
    group_width(entries, bits, max_distance, &mut groups);
  }
  groups.sort_unstable_by_key(|group| group.ids[0]);
  groups
}

struct DisjointSet {
  parent: Vec<u32>,
  size: Vec<u32>,
}

impl DisjointSet {
  fn new(len: usize) -> Self {
    Self {
      parent: (0..len as u32).collect(),
      size: vec![1; len],
    }
  }

  fn find(&mut self, mut node: u32) -> u32 {
    while self.parent[node as usize] != node {
      let grandparent = self.parent[self.parent[node as usize] as usize];
      self.parent[node as usize] = grandparent;
      node = grandparent;
    }
    node
  }

  fn union(&mut self, left: u32, right: u32) {
    let (mut left, mut right) = (self.find(left), self.find(right));
    if left == right {
      return;
    }
    if self.size[left as usize] < self.size[right as usize] {
      std::mem::swap(&mut left, &mut right);
    }
    self.parent[right as usize] = left;
    self.size[left as usize] += self.size[right as usize];
  }
}

fn group_width(
  mut entries: Vec<(u64, i64)>,
  bits: u32,
  max_distance: u32,
  groups: &mut Vec<NearDuplicateGroup>,
) {
  // Collapse identical hashes so exact duplicates never cost pairwise work.
  entries.sort_unstable();
  let mut values: Vec<u64> = Vec::new();
  let mut runs: Vec<usize> = Vec::new();
  for (index, &(value, _)) in entries.iter().enumerate() {
    if values.last() != Some(&value) {
      values.push(value);
      runs.push(index);
    }
  }
  runs.push(entries.len());

  let mut sets = DisjointSet::new(values.len());
  if max_distance >= bits {
    // Every pair of same-width hashes is within range.
    for index in 1..values.len() as u32 {
      sets.union(0, index);
    }
  } else {
    let chunks = max_distance + 1;
    let mut keys: Vec<u64> = Vec::with_capacity(values.len());
    let mut offset = 0;
    for chunk in 0..chunks {
      // Spread the remainder so widths differ by at most one bit.
      let width = bits / chunks + u32::from(chunk < bits % chunks);
      let mask = (1u64 << width) - 1;
      keys.clear();
      keys.extend(
        values
          .iter()
          .enumerate()
          .map(|(index, value)| (((value >> offset) & mask) << 32) | index as u64),
      );
      keys.sort_unstable();
      let mut start = 0;
      while start < keys.len() {
        let bucket = keys[start] >> 32;
        let mut end = start + 1;
        while end < keys.len() && keys[end] >> 32 == bucket {
          end += 1;
        }
        for left in start..end {
          let left_index = keys[left] as u32;
          let left_value = values[left_index as usize];
          for &key in &keys[left + 1..end] {
            let right_index = key as u32;
            if (left_value ^ values[right_index as usize]).count_ones() <= max_distance {
              sets.union(left_index, right_index);
            }
          }
        }
        start = end;
      }
      offset += width;
    }
  }

  let mut components: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
  for index in 0..values.len() as u32 {
    components.entry(sets.find(index)).or_default().push(index);
  }
  for members in components.into_values() {
    let count: usize = members
      .iter()
      .map(|&index| runs[index as usize + 1] - runs[index as usize])
      .sum();
    if count < 2 {
      continue;
    }
    let mut max = 0;
    for (position, &left) in members.iter().enumerate() {
      for &right in &members[position + 1..] {
        max = max.max((values[left as usize] ^ values[right as usize]).count_ones());
      }
    }
    let mut ids: Vec<i64> = members
      .iter()
      .flat_map(|&index| &entries[runs[index as usize]..runs[index as usize + 1]])
      .map(|&(_, id)| id)
      .collect();
    ids.sort_unstable();
    groups.push(NearDuplicateGroup {
      ids,
      max_distance: max,
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Base64 of a 40-bit hash, the width of the scan pipeline's DoubleGradient 8x8.
  fn encode(value: u64) -> String {
    ImageHash::<Box<[u8]>>::from_bytes(&value.to_be_bytes()[3..])
      .unwrap()
      .to_base64()
  }

  fn run(hashes: &[u64], max_distance: u32) -> Vec<NearDuplicateGroup> {
    let ids: Vec<i64> = (1..=hashes.len() as i64).collect();
    let hashes: Vec<String> = hashes.iter().map(|&value| encode(value)).collect();
    group_near_duplicates(ids, hashes, max_distance).unwrap()
  }

  fn group_of(ids: &[i64], max_distance: u32) -> NearDuplicateGroup {
    NearDuplicateGroup {
      ids: ids.to_vec(),
      max_distance,
    }
  }

  #[test]
  fn real_pipeline_hashes_are_forty_bits() {
    let image = image::DynamicImage::new_rgb8(64, 48);
    let hash = crate::phash::generate_phash_from_image(&image);
    assert_eq!(decode(&hash).map(|(_, bits)| bits), Some(40));
  }

  #[test]
  fn groups_at_the_threshold_but_not_one_bit_beyond() {
    let base = 0x00_f0f0_f0f0;
    // Pair 1/2 differs by exactly 4 bits, pair 3/4 by 5 bits.
    let groups = run(
      &[
        base,
        base ^ 0b1111,
        !base & 0xff_ffff_ffff,
        (!base & 0xff_ffff_ffff) ^ 0b11111,
      ],
      4,
    );
    assert_eq!(groups, vec![group_of(&[1, 2], 4)]);
    assert_eq!(
      run(&[base, base ^ 0b1111], 3),
      Vec::<NearDuplicateGroup>::new()
    );
  }

  #[test]
  fn grouping_is_transitive_and_reports_the_group_diameter() {
    let a = 0;
    let b = 0b111; // 3 from a
    let c = 0b111_111; // 3 from b, 6 from a
    let far = 0xff_ff00_0000;
    assert_eq!(run(&[a, far, b, c], 3), vec![group_of(&[1, 3, 4], 6)]);
  }

  #[test]
  fn identical_hashes_group_with_distance_zero_and_singletons_are_dropped() {
    assert_eq!(
      run(&[42, 0xff_ffff_ffff, 42, 42], 0),
      vec![group_of(&[1, 3, 4], 0)]
    );
  }

  #[test]
  fn undecodable_and_oversized_hashes_are_skipped() {
    let near = encode(0b1);
    let hashes = vec![
      encode(0),
      "not base64!".to_string(),
      String::new(),
      // 9 bytes cannot be packed into 64 bits.
      ImageHash::<Box<[u8]>>::from_bytes(&[0; 9])
        .unwrap()
        .to_base64(),
      near,
    ];
    let groups = group_near_duplicates(vec![10, 11, 12, 13, 14], hashes, 2).unwrap();
    assert_eq!(groups, vec![group_of(&[10, 14], 1)]);
  }

  #[test]
  fn hashes_of_different_widths_are_never_compared() {
    let short = ImageHash::<Box<[u8]>>::from_bytes(&[0; 4])
      .unwrap()
      .to_base64();
    let groups = group_near_duplicates(vec![1, 2], vec![encode(0), short], 8).unwrap();
    assert!(groups.is_empty());
  }

  #[test]
  fn misaligned_inputs_are_rejected() {
    assert!(group_near_duplicates(vec![1, 2], vec![encode(0)], 4).is_err());
  }

  #[test]
  fn threshold_covering_every_bit_groups_everything() {
    assert_eq!(
      run(&[0, 0xff_ffff_ffff, 0x0f_0f0f_0f0f], 40),
      vec![group_of(&[1, 2, 3], 40)]
    );
  }

  #[test]
  fn multi_index_matches_brute_force_components() {
    // Deterministic xorshift values with planted near neighbours.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
      state ^= state << 13;
      state ^= state >> 7;
      state ^= state << 17;
      state
    };
    let mut hashes = Vec::new();
    for _ in 0..400 {
      let value = next() & 0xff_ffff_ffff;
      hashes.push(value);
      if value % 3 == 0 {
        hashes.push(value ^ (1 << (next() % 40)) ^ (1 << (next() % 40)));
      }
    }
    for max_distance in 0..=8 {
      let mut sets = DisjointSet::new(hashes.len());
      for left in 0..hashes.len() {
        for right in left + 1..hashes.len() {
          if (hashes[left] ^ hashes[right]).count_ones() <= max_distance {
            sets.union(left as u32, right as u32);
          }
        }
      }
      let mut expected: BTreeMap<u32, Vec<i64>> = BTreeMap::new();
      for index in 0..hashes.len() {
        expected
          .entry(sets.find(index as u32))
          .or_default()
          .push(index as i64 + 1);
      }
      let mut expected: Vec<Vec<i64>> =
        expected.into_values().filter(|ids| ids.len() > 1).collect();
      expected.sort();
      let actual: Vec<Vec<i64>> = run(&hashes, max_distance)
        .into_iter()
        .map(|group| group.ids)
        .collect();
      assert_eq!(actual, expected, "max_distance {max_distance}");
    }
  }
}

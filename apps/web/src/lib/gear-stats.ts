import type { CameraYear, GearCount } from "./types";

/** Cameras and lenses listed before "Show all" expands the full list. */
export const GEAR_LIST_PREVIEW_LIMIT = 10;

/** Cameras with their own shots-per-year segment; the rest share "Other". */
export const SHOTS_PER_YEAR_TOP_CAMERAS = 5;

export const OTHER_CAMERAS_LABEL = "Other";

/** "1 photo" / "1,234 photos". */
export function photoCountLabel(count: number) {
	return count === 1 ? "1 photo" : `${count.toLocaleString("en-US")} photos`;
}

/** Accessible bar label shared with iOS: "35–49 mm: 120 photos". */
export function gearCountLabel(entry: { label: string; count: number }) {
	return `${entry.label}: ${photoCountLabel(entry.count)}`;
}

/** View header: "N photos · M with camera data". */
export function gearSummary(stats: { total: number; withExif: number }) {
	return `${photoCountLabel(stats.total)} · ${stats.withExif.toLocaleString("en-US")} with camera data`;
}

/** The first GEAR_LIST_PREVIEW_LIMIT entries (API order), or all of them. */
export function previewGearCounts(
	entries: readonly GearCount[],
	showAll: boolean,
): readonly GearCount[] {
	return showAll ? entries : entries.slice(0, GEAR_LIST_PREVIEW_LIMIT);
}

/** Bar length in percent of the largest count; 0 when nothing is counted. */
export function barPercent(count: number, max: number) {
	return max > 0 ? (count / max) * 100 : 0;
}

/** One camera's share of a year; `camera` null is the grouped "Other". */
export interface YearSegment {
	camera: string | null;
	count: number;
}

export interface YearShots {
	year: number;
	total: number;
	/** Top cameras in rank order, then Other; zero segments omitted. */
	segments: YearSegment[];
}

export interface ShotsPerYear {
	/** The top cameras by total count (count desc, camera asc), in rank order. */
	cameras: string[];
	/** Whether any year has an "Other" segment. */
	hasOther: boolean;
	/** Years ascending. */
	years: YearShots[];
}

/**
 * Groups `cameraYears` per year, segmented by the `topCount` cameras with the
 * most photos across all years; every other camera is summed into "Other".
 */
export function shotsPerYear(
	cameraYears: readonly CameraYear[],
	topCount = SHOTS_PER_YEAR_TOP_CAMERAS,
): ShotsPerYear {
	const cameraTotals = new Map<string, number>();
	for (const { camera, count } of cameraYears) {
		cameraTotals.set(camera, (cameraTotals.get(camera) ?? 0) + count);
	}
	const cameras = [...cameraTotals]
		.sort(
			([cameraA, countA], [cameraB, countB]) =>
				countB - countA || (cameraA < cameraB ? -1 : cameraA > cameraB ? 1 : 0),
		)
		.slice(0, topCount)
		.map(([camera]) => camera);
	const rank = new Map(cameras.map((camera, index) => [camera, index]));

	const byYear = new Map<number, { counts: number[]; other: number }>();
	for (const { camera, year, count } of cameraYears) {
		let entry = byYear.get(year);
		if (!entry) {
			entry = { counts: cameras.map(() => 0), other: 0 };
			byYear.set(year, entry);
		}
		const index = rank.get(camera);
		if (index === undefined) entry.other += count;
		else entry.counts[index] += count;
	}

	let hasOther = false;
	const years = [...byYear]
		.sort(([a], [b]) => a - b)
		.map(([year, { counts, other }]) => {
			const segments: YearSegment[] = counts.flatMap((count, index) =>
				count > 0 ? [{ camera: cameras[index], count }] : [],
			);
			if (other > 0) {
				hasOther = true;
				segments.push({ camera: null, count: other });
			}
			const total = segments.reduce((sum, s) => sum + s.count, 0);
			return { year, total, segments };
		});
	return { cameras, hasOther, years };
}

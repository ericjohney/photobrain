import type { SQLQueryBindings } from "bun:sqlite";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { capturedDateSql } from "../db/schema";
import type { CollectionCover } from "./collections";
import {
	type ApiDatabase,
	currentPlaceSql,
	folderSubtreePattern,
	pairStackingCondition,
} from "./photo-catalog";
import { embeddingFromBlob } from "./photo-tagging";
import { EMBEDDING_MODEL_VERSION } from "./processing-versions";

/** Bump when the detection rules change; recorded on every `events` row. */
export const EVENTS_VERSION = 1;
/** A capture gap of at least this many hours always starts a new event. */
export const EVENT_GAP_HOURS = 6;
/** A gap of at least this many minutes starts a new event on a scene change. */
export const EVENT_SCENE_GAP_MINUTES = 60;
/** CLIP cosine similarity below this between neighbours is a scene change. */
export const EVENT_SCENE_SIMILARITY = 0.6;
/** Runs with fewer photos are not events. */
export const EVENT_MIN_PHOTOS = 6;

const GAP_MS = EVENT_GAP_HOURS * 3_600_000;
const SCENE_GAP_MS = EVENT_SCENE_GAP_MINUTES * 60_000;

/** City place (all fields) or country-only place (`city`/`region` null). */
export type EventPlace = {
	city: string | null;
	region: string | null;
	country: string;
	countryCode: string;
};

/** `events` / `GET /api/v1/events` event. */
export type PhotoEvent = {
	/** Smallest member photo ID; the `event` filter value. */
	id: number;
	/** First member's capture wall clock, `YYYY-MM-DDTHH:MM:SS` (no zone). */
	startAt: string;
	/** Last member's capture wall clock, `YYYY-MM-DDTHH:MM:SS` (no zone). */
	endAt: string;
	photoCount: number;
	cover: CollectionCover;
	place: EventPlace | null;
};

export type EventsResult = { events: PhotoEvent[] };

export type EventDetectionResult = {
	/** Ordered candidates read (dated, not rejected, pairs stacked). */
	candidates: number;
	/** Events written. */
	events: number;
	/** Member rows written. */
	photos: number;
};

/**
 * The EXIF `date_taken` text is a valid wall-clock capture datetime: a real
 * `YYYY-MM-DD` date (either `:` or `-` separators) in year 1900 or later, a
 * space or `T`, and a real `HH:MM:SS` time. Any suffix (fractional seconds,
 * zone offset) is ignored; nothing is converted between zones.
 */
function validCaptureDateTimeSql(dateTaken: SQL): SQL {
	const date = capturedDateSql(dateTaken);
	const time = sql`substr(${dateTaken}, 12, 8)`;
	return sql`(${date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
		AND ${date} >= '1900' AND date(${date}) = ${date}
		AND substr(${dateTaken}, 11, 1) IN (' ', 'T')
		AND ${time} GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
		AND ${time} < '24' AND time(${time}) = ${time})`;
}

type CandidateRow = {
	id: number;
	captured_at: string;
	rating: number;
	geoname_id: number | null;
	city: string | null;
	region: string | null;
	country: string | null;
	country_code: string | null;
	embedding: Uint8Array | null;
};

/**
 * Detection candidates in capture order (then ID): photos with a valid capture
 * datetime, not rejected, RAW+JPEG pairs stacked like the library listing (the
 * RAW drops out when its partner is also a candidate, so a pair is one member),
 * each with its current place and its current-model, current-generation vector.
 */
function candidatesSql(): SQL {
	const dateTaken = sql`candidate.date_taken`;
	const notRejected = sql`(photos.flag IS NULL OR photos.flag <> 'reject')`;
	const dated = sql`EXISTS (SELECT 1 FROM photo_exif pair_exif WHERE pair_exif.photo_id = photos.id AND ${validCaptureDateTimeSql(sql`pair_exif.date_taken`)})`;
	return sql`
		SELECT
			photos.id AS id,
			(${capturedDateSql(dateTaken)} || 'T' || substr(${dateTaken}, 12, 8)) AS captured_at,
			photos.rating AS rating,
			place.geoname_id AS geoname_id,
			place.city AS city,
			place.region AS region,
			place.country AS country,
			place.country_code AS country_code,
			CASE
				WHEN photos.embedding_status = 'completed'
					AND vector.model_version = ${EMBEDDING_MODEL_VERSION}
					AND vector.thumbnail_key IS photos.thumbnail_key
				THEN vector.embedding
			END AS embedding
		FROM photo_exif candidate
		INNER JOIN photos ON photos.id = candidate.photo_id
		LEFT JOIN photo_places place ON place.photo_id = photos.id AND ${currentPlaceSql("place")}
		LEFT JOIN photo_embedding vector ON vector.photo_id = photos.id
		WHERE ${validCaptureDateTimeSql(dateTaken)}
			AND ${notRejected}
			AND ${pairStackingCondition([dated, notRejected])}
		ORDER BY captured_at, photos.id
	`;
}

/** Milliseconds of a `YYYY-MM-DDTHH:MM:SS` wall clock, read as if UTC. */
function wallClockMs(value: string): number {
	return Date.UTC(
		Number(value.slice(0, 4)),
		Number(value.slice(5, 7)) - 1,
		Number(value.slice(8, 10)),
		Number(value.slice(11, 13)),
		Number(value.slice(14, 16)),
		Number(value.slice(17, 19)),
	);
}

type Vector = { values: Float32Array; norm: number };

function toVector(blob: Uint8Array | null): Vector | null {
	if (blob === null) return null;
	const values = embeddingFromBlob(blob);
	let squares = 0;
	for (let index = 0; index < values.length; index++) {
		squares += values[index] * values[index];
	}
	const norm = Math.sqrt(squares);
	return norm > 0 && Number.isFinite(norm) ? { values, norm } : null;
}

/** Cosine similarity, or `null` when the vectors cannot be compared. */
function cosine(left: Vector, right: Vector): number | null {
	if (left.values.length !== right.values.length) return null;
	let dot = 0;
	for (let index = 0; index < left.values.length; index++) {
		dot += left.values[index] * right.values[index];
	}
	return dot / (left.norm * right.norm);
}

type PlaceTally = EventPlace & { count: number };

type Run = {
	memberIds: number[];
	minId: number;
	startAt: string;
	endAt: string;
	coverId: number;
	coverRating: number;
	located: number;
	cities: Map<number, PlaceTally>;
	countries: Map<string, PlaceTally>;
};

function addToRun(run: Run, row: CandidateRow): void {
	run.memberIds.push(row.id);
	run.minId = Math.min(run.minId, row.id);
	run.endAt = row.captured_at;
	// Rows arrive by capture time then ID, so `>=` keeps the newest capture
	// (then highest ID) among the highest ratings.
	if (row.rating >= run.coverRating) {
		run.coverId = row.id;
		run.coverRating = row.rating;
	}
	if (
		row.geoname_id === null ||
		row.city === null ||
		row.country === null ||
		row.country_code === null
	) {
		return;
	}
	run.located++;
	const city = run.cities.get(row.geoname_id);
	if (city) city.count++;
	else {
		run.cities.set(row.geoname_id, {
			city: row.city,
			region: row.region,
			country: row.country,
			countryCode: row.country_code,
			count: 1,
		});
	}
	const country = run.countries.get(row.country_code);
	if (country) country.count++;
	else {
		run.countries.set(row.country_code, {
			city: null,
			region: null,
			country: row.country,
			countryCode: row.country_code,
			count: 1,
		});
	}
}

/** The first-seen tally with the highest count, if it covers half of `located`. */
function majority(
	tallies: Map<unknown, PlaceTally>,
	located: number,
): EventPlace | null {
	let best: PlaceTally | null = null;
	for (const tally of tallies.values()) {
		if (!best || tally.count > best.count) best = tally;
	}
	if (!best || best.count * 2 < located) return null;
	const { count: _count, ...place } = best;
	return place;
}

/**
 * The most common city among located members when it covers at least half of
 * them; else the most common country when it does (`city`/`region` null);
 * else `null` (also when no member has a current place).
 */
function runPlace(run: Run): EventPlace | null {
	if (run.located === 0) return null;
	return (
		majority(run.cities, run.located) ?? majority(run.countries, run.located)
	);
}

const dialect = new SQLiteSyncDialect();

/**
 * Recomputes every event from scratch and atomically replaces `events` and
 * `event_photos` in one transaction, so readers see either the old or the new
 * set. Candidates (see `candidatesSql`) stream from a single statement in
 * capture order; only the previous candidate's vector and the current run's
 * member IDs and tallies are held in memory.
 *
 * Consecutive candidates are split when their capture gap is at least
 * `EVENT_GAP_HOURS`, or at least `EVENT_SCENE_GAP_MINUTES` and either both
 * have current places with different GeoNames cities or both have vectors
 * with cosine similarity below `EVENT_SCENE_SIMILARITY`. Runs with at least
 * `EVENT_MIN_PHOTOS` members become events identified by their smallest photo
 * ID; the cover is the highest rating, then newest capture, then highest ID.
 */
export function detectEvents(database: ApiDatabase): EventDetectionResult {
	const client = database.$client;
	const candidates = dialect.sqlToQuery(candidatesSql());
	return database.transaction((tx) => {
		tx.run(sql`DELETE FROM event_photos`);
		tx.run(sql`DELETE FROM events`);
		const insertEvent = client.query<
			unknown,
			[
				number,
				string,
				string,
				number,
				number,
				string | null,
				string | null,
				string | null,
				string | null,
				number,
			]
		>(
			`INSERT INTO events (id, start_at, end_at, photo_count, cover_photo_id,
				city, region, country, country_code, events_version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insertMember = client.query<unknown, [number, number]>(
			"INSERT INTO event_photos (event_id, photo_id) VALUES (?, ?)",
		);
		const result: EventDetectionResult = {
			candidates: 0,
			events: 0,
			photos: 0,
		};
		const finish = (run: Run) => {
			if (run.memberIds.length < EVENT_MIN_PHOTOS) return;
			const place = runPlace(run);
			insertEvent.run(
				run.minId,
				run.startAt,
				run.endAt,
				run.memberIds.length,
				run.coverId,
				place?.city ?? null,
				place?.region ?? null,
				place?.country ?? null,
				place?.countryCode ?? null,
				EVENTS_VERSION,
			);
			for (const photoId of run.memberIds) insertMember.run(run.minId, photoId);
			result.events++;
			result.photos += run.memberIds.length;
		};

		let run: Run | null = null;
		let previousMs = 0;
		let previousGeonameId: number | null = null;
		let previousVector: Vector | null = null;
		const rows = client
			.query<CandidateRow, SQLQueryBindings[]>(candidates.sql)
			.iterate(...(candidates.params as SQLQueryBindings[]));
		for (const row of rows) {
			result.candidates++;
			const ms = wallClockMs(row.captured_at);
			const vector = toVector(row.embedding);
			if (run) {
				const gap = ms - previousMs;
				let split = gap >= GAP_MS;
				if (!split && gap >= SCENE_GAP_MS) {
					const placeChanged =
						previousGeonameId !== null &&
						row.geoname_id !== null &&
						previousGeonameId !== row.geoname_id;
					const similarity =
						previousVector && vector ? cosine(previousVector, vector) : null;
					split =
						placeChanged ||
						(similarity !== null && similarity < EVENT_SCENE_SIMILARITY);
				}
				if (split) {
					finish(run);
					run = null;
				}
			}
			run ??= {
				memberIds: [],
				minId: row.id,
				startAt: row.captured_at,
				endAt: row.captured_at,
				coverId: row.id,
				coverRating: row.rating,
				located: 0,
				cities: new Map(),
				countries: new Map(),
			};
			addToRun(run, row);
			previousMs = ms;
			previousGeonameId = row.geoname_id;
			previousVector = vector;
		}
		if (run) finish(run);
		return result;
	});
}

type EventRow = {
	id: number;
	start_at: string;
	end_at: string;
	photo_count: number;
	city: string | null;
	region: string | null;
	country: string | null;
	country_code: string | null;
	cover_photo_id: number;
	cover_thumbnail_updated_at: number | null;
};

/**
 * Detected events, newest first (`start_at` then ID, descending, read
 * backwards from `idx_events_start_at_id`). With `folder`, only events with a
 * member anywhere below that folder; `photoCount` stays the whole event's.
 */
export function listEvents(
	database: ApiDatabase,
	input: { folder?: string } = {},
): EventsResult {
	const folderCondition = input.folder
		? sql`WHERE EXISTS (SELECT 1 FROM event_photos member
				INNER JOIN photos member_photo ON member_photo.id = member.photo_id
				WHERE member.event_id = events.id
					AND member_photo.path LIKE ${folderSubtreePattern(input.folder)} ESCAPE '\\')`
		: sql``;
	const rows = database.all<EventRow>(sql`
		SELECT
			events.id AS id,
			events.start_at AS start_at,
			events.end_at AS end_at,
			events.photo_count AS photo_count,
			events.city AS city,
			events.region AS region,
			events.country AS country,
			events.country_code AS country_code,
			cover.id AS cover_photo_id,
			cover.thumbnail_updated_at AS cover_thumbnail_updated_at
		FROM events
		INNER JOIN photos cover ON cover.id = events.cover_photo_id
		${folderCondition}
		ORDER BY events.start_at DESC, events.id DESC
	`);
	return {
		events: rows.map((row) => ({
			id: row.id,
			startAt: row.start_at,
			endAt: row.end_at,
			photoCount: row.photo_count,
			cover: {
				photoId: row.cover_photo_id,
				// Drizzle timestamp columns store whole seconds.
				thumbnailUpdatedAt:
					row.cover_thumbnail_updated_at === null
						? null
						: new Date(row.cover_thumbnail_updated_at * 1000),
			},
			place:
				row.country === null || row.country_code === null
					? null
					: {
							city: row.city,
							region: row.region,
							country: row.country,
							countryCode: row.country_code,
						},
		})),
	};
}

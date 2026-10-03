import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export const BASELINE_VERSION = 1;
export const PHOTO_COUNT = 7_961;
export const PHOTO_FIXTURE_FILE = "photo-metadata.json";
export const FORMAT_MANIFEST_FILE = "format-manifest.json";
export const DEFAULT_OUTPUT_DIRECTORY = join(
	tmpdir(),
	"photobrain-native-migration-baseline",
);

export const LIBRARY_FORMAT_COUNTS = Object.freeze({
	ARW: 4_796,
	RAF: 1_232,
	DNG: 1_181,
	HEIC: 454,
	JPG: 277,
	JPEG: 13,
	PNG: 8,
});

export const MANIFEST_FORMAT_COUNTS = Object.freeze({
	ARW: 12,
	RAF: 12,
	DNG: 12,
	HEIC: 12,
	JPG: 12,
	JPEG: 12,
	PNG: 8,
});

export const SYNTHETIC_COVERAGE_DISTRIBUTIONS = Object.freeze({
	exif: Object.freeze({ present: 6_766, null: 1_195 }),
	raw: Object.freeze({ present: 7_209, null: 752 }),
	rawStatus: Object.freeze({ completed: 7_115, failed: 3, null: 91 }),
	thumbnailStatus: Object.freeze({ completed: 7_876, failed: 3, null: 82 }),
	embeddingStatus: Object.freeze({ completed: 7_872, null: 89 }),
	phashStatus: Object.freeze({ completed: 7_866, null: 95 }),
	dateFallback: Object.freeze({
		dateTaken: 5_572,
		modifiedAt: 1_194,
		createdAt: 797,
		null: 398,
	}),
});

export const EXPO_OBSERVABLE_PARITY = Object.freeze({
	basis: "current-expo-observable-contract",
	measurementClaim: null,
	grid: Object.freeze({
		phoneColumns: 5,
		responsiveColumns: Object.freeze([5, 6, 7, 8]),
	}),
	chronology: Object.freeze({
		dateFallbackOrder: Object.freeze([
			"exif.dateTaken",
			"modifiedAt",
			"createdAt",
		]),
		defaultOrder: "oldest-first",
	}),
	selection: Object.freeze({
		mode: "basic-grid-selection",
		persistentCloseControl: true,
		bulkActions: false,
	}),
	filters: Object.freeze({
		applyMode: "immediate",
		categories: Object.freeze([
			"raw-or-standard",
			"camera",
			"lens",
			"iso",
			"month",
		]),
	}),
	search: Object.freeze({
		mode: "semantic-text",
		location: "isolated-native-tab",
		debounceMilliseconds: 350,
	}),
	loupe: Object.freeze({
		presentation: "full-screen-modal",
		interactions: Object.freeze([
			"paged-swipe",
			"native-ios-pinch-zoom",
			"synchronized-thumbnail-filmstrip",
			"metadata",
		]),
	}),
	scanCopy: Object.freeze({
		incrementalAction: "Scan Library",
		reprocessAction: "Reprocess all photos",
		reprocessTitle: "Reprocess all photos?",
		reprocessMessage:
			"This regenerates thumbnails and search embeddings for every photo. Original files are left untouched. This takes longer than a normal library scan.",
	}),
});

const PHOTO_SCHEMA = "urn:photobrain:native-migration:photo-metadata:v1";
const MANIFEST_SCHEMA = "urn:photobrain:native-migration:format-manifest:v1";
const FORMATS = Object.keys(LIBRARY_FORMAT_COUNTS);
const RAW_FORMATS = new Set(["ARW", "RAF", "DNG"]);
const STATUS_VALUES = new Set(["completed", "failed", null]);
const DATE_FALLBACK_VALUES = new Set([
	"dateTaken",
	"modifiedAt",
	"createdAt",
	null,
]);
const DNG_FAILURE_IDS = new Set([
	"redacted-006029",
	"redacted-006030",
	"redacted-006031",
]);

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function exactKeys(value, keys, context) {
	assert(
		value && typeof value === "object" && !Array.isArray(value),
		`${context} must be an object.`,
	);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${context} has unexpected fields.`,
	);
}

function sha256(value) {
	return createHash("sha256")
		.update(`${JSON.stringify(value)}\n`)
		.digest("hex");
}

function seal(payload) {
	return { ...payload, hash: sha256(payload) };
}

function withoutHash(document) {
	const { hash: _hash, ...payload } = document;
	return payload;
}

function syntheticDate(id) {
	return new Date(Date.UTC(2000, 0, 1 + ((id - 1) % 3_650))).toISOString();
}

function datesFor(id) {
	const remainder = id % 20;
	const date = syntheticDate(id);
	if (remainder === 0) {
		return {
			exif: null,
			modifiedAt: null,
			createdAt: null,
			dateFallback: null,
		};
	}
	if (remainder <= 2) {
		return {
			exif: null,
			modifiedAt: null,
			createdAt: date,
			dateFallback: "createdAt",
		};
	}
	if (remainder <= 5) {
		return {
			exif: { dateTaken: null },
			modifiedAt: date,
			createdAt: date,
			dateFallback: "modifiedAt",
		};
	}
	return {
		exif: { dateTaken: date },
		modifiedAt: date,
		createdAt: date,
		dateFallback: "dateTaken",
	};
}

function photoRow(id, format) {
	const fixtureId = `redacted-${String(id).padStart(6, "0")}`;
	const failed = DNG_FAILURE_IDS.has(fixtureId);
	const raw = RAW_FORMATS.has(format)
		? {
				format,
				status: failed ? "failed" : id % 79 === 0 ? null : "completed",
			}
		: null;
	return {
		fixtureId,
		format,
		...datesFor(id),
		raw,
		statuses: {
			thumbnail: failed ? "failed" : id % 97 === 0 ? null : "completed",
			embedding: id % 89 === 0 ? null : "completed",
			phash: id % 83 === 0 ? null : "completed",
		},
	};
}

function countValues(rows, select, values) {
	const counts = Object.fromEntries(values.map((value) => [String(value), 0]));
	for (const row of rows) counts[String(select(row))]++;
	return counts;
}

function photoDistributions(photos) {
	return {
		exif: {
			present: photos.filter((photo) => photo.exif !== null).length,
			null: photos.filter((photo) => photo.exif === null).length,
		},
		raw: {
			present: photos.filter((photo) => photo.raw !== null).length,
			null: photos.filter((photo) => photo.raw === null).length,
		},
		rawStatus: countValues(
			photos.filter((photo) => photo.raw !== null),
			(photo) => photo.raw.status,
			["completed", "failed", null],
		),
		thumbnailStatus: countValues(photos, (photo) => photo.statuses.thumbnail, [
			"completed",
			"failed",
			null,
		]),
		embeddingStatus: countValues(photos, (photo) => photo.statuses.embedding, [
			"completed",
			null,
		]),
		phashStatus: countValues(photos, (photo) => photo.statuses.phash, [
			"completed",
			null,
		]),
		dateFallback: countValues(photos, (photo) => photo.dateFallback, [
			"dateTaken",
			"modifiedAt",
			"createdAt",
			null,
		]),
	};
}

function formatCounts(rows) {
	const counts = Object.fromEntries(FORMATS.map((format) => [format, 0]));
	for (const row of rows) counts[row.format]++;
	return counts;
}

function assertPrivacySafe(value, context = "document") {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			assertPrivacySafe(value[index], `${context}[${index}]`);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		if (typeof value === "string") {
			assert(
				!isAbsolute(value) && !win32.isAbsolute(value),
				`${context} contains an absolute path.`,
			);
			assert(!value.startsWith("file:"), `${context} contains a file URL.`);
		}
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		assert(
			!/(?:^|_)(?:file)?name$|path|gps|latitude|longitude|altitude/i.test(key),
			`${context}.${key} is private metadata.`,
		);
		assertPrivacySafe(child, `${context}.${key}`);
	}
}

export function createPhotoFixture() {
	const photos = [];
	let id = 1;
	for (const [format, count] of Object.entries(LIBRARY_FORMAT_COUNTS)) {
		for (let index = 0; index < count; index++)
			photos.push(photoRow(id++, format));
	}
	const payload = {
		$schema: PHOTO_SCHEMA,
		version: BASELINE_VERSION,
		dataClassification: "synthetic-redacted",
		distributionEvidence: "synthetic-coverage-not-production-observation",
		photoCount: photos.length,
		distributions: photoDistributions(photos),
		expoObservableParity: EXPO_OBSERVABLE_PARITY,
		photos,
	};
	const fixture = seal(payload);
	validatePhotoFixture(fixture);
	return fixture;
}

export function createFormatManifest() {
	const files = [];
	for (const [format, count] of Object.entries(MANIFEST_FORMAT_COUNTS)) {
		for (let ordinal = 1; ordinal <= count; ordinal++) {
			const isFailure = format === "DNG" && ordinal > count - 3;
			files.push({
				fixtureId: `format-${format.toLowerCase()}-${String(ordinal).padStart(2, "0")}`,
				format,
				expectedOutcome: isFailure ? "failure" : "success",
				failureClass: isFailure ? "missing-embedded-preview" : null,
			});
		}
	}
	const payload = {
		$schema: MANIFEST_SCHEMA,
		version: BASELINE_VERSION,
		dataClassification: "synthetic-redacted",
		distributionEvidence: "synthetic-coverage-not-production-observation",
		fileCount: files.length,
		failureCount: files.filter((file) => file.expectedOutcome === "failure")
			.length,
		formatCounts: MANIFEST_FORMAT_COUNTS,
		files,
	};
	const manifest = seal(payload);
	validateFormatManifest(manifest);
	return manifest;
}

export function validatePhotoFixture(fixture) {
	exactKeys(
		fixture,
		[
			"$schema",
			"version",
			"dataClassification",
			"distributionEvidence",
			"photoCount",
			"distributions",
			"expoObservableParity",
			"photos",
			"hash",
		],
		"Photo fixture",
	);
	assert(fixture.$schema === PHOTO_SCHEMA, "Photo fixture schema drifted.");
	assert(
		fixture.version === BASELINE_VERSION,
		"Photo fixture version drifted.",
	);
	assert(
		fixture.dataClassification === "synthetic-redacted",
		"Photo fixture is not marked synthetic and redacted.",
	);
	assert(
		fixture.distributionEvidence ===
			"synthetic-coverage-not-production-observation",
		"Photo fixture must not claim a measured production distribution.",
	);
	assert(
		Array.isArray(fixture.photos),
		"Photo fixture photos must be an array.",
	);
	assert(
		fixture.photoCount === PHOTO_COUNT && fixture.photos.length === PHOTO_COUNT,
		`Photo fixture must contain exactly ${PHOTO_COUNT} rows.`,
	);
	assert(
		/^[a-f\d]{64}$/.test(fixture.hash),
		"Photo fixture hash is malformed.",
	);
	assert(
		fixture.hash === sha256(withoutHash(fixture)),
		"Photo fixture hash does not match its payload.",
	);
	assert(
		JSON.stringify(fixture.expoObservableParity) ===
			JSON.stringify(EXPO_OBSERVABLE_PARITY),
		"Expo observable parity drifted.",
	);

	for (let index = 0; index < fixture.photos.length; index++) {
		const photo = fixture.photos[index];
		const context = `Photo row ${index + 1}`;
		exactKeys(
			photo,
			[
				"fixtureId",
				"format",
				"exif",
				"modifiedAt",
				"createdAt",
				"dateFallback",
				"raw",
				"statuses",
			],
			context,
		);
		assert(
			photo.fixtureId === `redacted-${String(index + 1).padStart(6, "0")}`,
			`${context} has a non-redacted or unstable identifier.`,
		);
		assert(
			FORMATS.includes(photo.format),
			`${context} has an unsupported format.`,
		);
		if (photo.exif !== null) {
			exactKeys(photo.exif, ["dateTaken"], `${context} EXIF`);
			assert(
				photo.exif.dateTaken === null ||
					(typeof photo.exif.dateTaken === "string" &&
						Number.isFinite(Date.parse(photo.exif.dateTaken))),
				`${context} has malformed EXIF.`,
			);
		}
		if (photo.raw !== null) {
			exactKeys(photo.raw, ["format", "status"], `${context} RAW metadata`);
			assert(
				RAW_FORMATS.has(photo.format) &&
					photo.raw.format === photo.format &&
					STATUS_VALUES.has(photo.raw.status),
				`${context} has malformed RAW metadata.`,
			);
		}
		assert(
			(photo.raw === null) === !RAW_FORMATS.has(photo.format),
			`${context} RAW nullability does not match its format.`,
		);
		exactKeys(
			photo.statuses,
			["thumbnail", "embedding", "phash"],
			`${context} statuses`,
		);
		assert(
			STATUS_VALUES.has(photo.statuses.thumbnail) &&
				STATUS_VALUES.has(photo.statuses.embedding) &&
				STATUS_VALUES.has(photo.statuses.phash),
			`${context} has an invalid status.`,
		);
		for (const date of [photo.modifiedAt, photo.createdAt]) {
			assert(
				date === null ||
					(typeof date === "string" && Number.isFinite(Date.parse(date))),
				`${context} has a malformed fallback date.`,
			);
		}
		assert(
			DATE_FALLBACK_VALUES.has(photo.dateFallback),
			`${context} has an invalid date fallback.`,
		);
		const selectedDate =
			photo.dateFallback === "dateTaken"
				? photo.exif?.dateTaken
				: photo.dateFallback === null
					? null
					: photo[photo.dateFallback];
		assert(
			(photo.dateFallback === null &&
				photo.exif === null &&
				photo.modifiedAt === null &&
				photo.createdAt === null) ||
				(typeof selectedDate === "string" &&
					Number.isFinite(Date.parse(selectedDate))),
			`${context} has inconsistent date fallback metadata.`,
		);
	}
	assert(
		JSON.stringify(formatCounts(fixture.photos)) ===
			JSON.stringify(LIBRARY_FORMAT_COUNTS),
		"Photo fixture format counts drifted.",
	);
	assert(
		JSON.stringify(fixture.distributions) ===
			JSON.stringify(SYNTHETIC_COVERAGE_DISTRIBUTIONS),
		"Photo fixture synthetic distributions drifted.",
	);
	assert(
		JSON.stringify(photoDistributions(fixture.photos)) ===
			JSON.stringify(fixture.distributions),
		"Photo fixture rows do not match their distribution summary.",
	);
	assertPrivacySafe(fixture);
	return fixture;
}

export function validateFormatManifest(manifest) {
	exactKeys(
		manifest,
		[
			"$schema",
			"version",
			"dataClassification",
			"distributionEvidence",
			"fileCount",
			"failureCount",
			"formatCounts",
			"files",
			"hash",
		],
		"Format manifest",
	);
	assert(
		manifest.$schema === MANIFEST_SCHEMA,
		"Format manifest schema drifted.",
	);
	assert(
		manifest.version === BASELINE_VERSION,
		"Format manifest version drifted.",
	);
	assert(
		manifest.dataClassification === "synthetic-redacted",
		"Format manifest is not marked synthetic and redacted.",
	);
	assert(
		manifest.distributionEvidence ===
			"synthetic-coverage-not-production-observation",
		"Format manifest must not claim a measured production distribution.",
	);
	assert(
		Array.isArray(manifest.files) &&
			manifest.fileCount === 80 &&
			manifest.files.length === 80,
		"Format manifest must contain exactly 80 files.",
	);
	assert(
		manifest.hash === sha256(withoutHash(manifest)),
		"Format manifest hash does not match its payload.",
	);
	assert(
		JSON.stringify(manifest.formatCounts) ===
			JSON.stringify(MANIFEST_FORMAT_COUNTS),
		"Format manifest declared counts drifted.",
	);
	assert(
		JSON.stringify(formatCounts(manifest.files)) ===
			JSON.stringify(MANIFEST_FORMAT_COUNTS),
		"Format manifest row counts drifted.",
	);
	const failures = manifest.files.filter(
		(file) => file.expectedOutcome === "failure",
	);
	assert(
		manifest.failureCount === 3 && failures.length === 3,
		"Format manifest must contain exactly three failure cases.",
	);
	assert(
		new Set(manifest.files.map((file) => file.fixtureId)).size ===
			manifest.files.length,
		"Format manifest fixture identifiers must be unique.",
	);
	for (const [index, file] of manifest.files.entries()) {
		exactKeys(
			file,
			["fixtureId", "format", "expectedOutcome", "failureClass"],
			`Format manifest row ${index + 1}`,
		);
		assert(
			/^format-(?:arw|raf|dng|heic|jpg|jpeg|png)-\d{2}$/.test(file.fixtureId),
			`Format manifest row ${index + 1} has an invalid synthetic identifier.`,
		);
		assert(
			FORMATS.includes(file.format),
			`Format manifest row ${index + 1} has an unsupported format.`,
		);
		assert(
			file.expectedOutcome === "success" || file.expectedOutcome === "failure",
			`Format manifest row ${index + 1} has an invalid outcome.`,
		);
		assert(
			(file.expectedOutcome === "failure" &&
				file.format === "DNG" &&
				file.failureClass === "missing-embedded-preview") ||
				(file.expectedOutcome === "success" && file.failureClass === null),
			`Format manifest row ${index + 1} has inconsistent failure metadata.`,
		);
	}
	assertPrivacySafe(manifest);
	return manifest;
}

export async function writeBaselineArtifacts(
	outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
) {
	const directory = resolve(outputDirectory);
	const fixture = createPhotoFixture();
	const manifest = createFormatManifest();
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(
			join(directory, PHOTO_FIXTURE_FILE),
			`${JSON.stringify(fixture, null, 2)}\n`,
			{ mode: 0o600 },
		),
		writeFile(
			join(directory, FORMAT_MANIFEST_FILE),
			`${JSON.stringify(manifest, null, 2)}\n`,
			{ mode: 0o600 },
		),
	]);
	return { directory, fixture, manifest };
}

export async function validateBaselineArtifacts(
	outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
) {
	const directory = resolve(outputDirectory);
	const [fixtureSource, manifestSource] = await Promise.all([
		readFile(join(directory, PHOTO_FIXTURE_FILE), "utf8"),
		readFile(join(directory, FORMAT_MANIFEST_FILE), "utf8"),
	]);
	return {
		directory,
		fixture: validatePhotoFixture(JSON.parse(fixtureSource)),
		manifest: validateFormatManifest(JSON.parse(manifestSource)),
	};
}

async function main(args) {
	const validateOnly = args[0] === "--validate";
	const positionals = validateOnly ? args.slice(1) : args;
	assert(
		positionals.length <= 1,
		"Usage: native-migration-baseline.mjs [--validate] [output-directory]",
	);
	const result = validateOnly
		? await validateBaselineArtifacts(positionals[0])
		: await writeBaselineArtifacts(positionals[0]);
	console.log(
		`${validateOnly ? "Validated" : "Wrote"} ${PHOTO_COUNT} privacy-safe rows in ${result.directory}`,
	);
	console.log(`Photo fixture SHA-256: ${result.fixture.hash}`);
	console.log(`Format manifest SHA-256: ${result.manifest.hash}`);
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

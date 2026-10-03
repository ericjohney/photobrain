import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { NATIVE_MIGRATION_BASELINE_CONTRACT } from "../__tests__/fixtures.ts";
import {
	BASELINE_VERSION,
	createFormatManifest,
	createPhotoFixture,
	EXPO_OBSERVABLE_PARITY,
	FORMAT_MANIFEST_FILE,
	LIBRARY_FORMAT_COUNTS,
	MANIFEST_FORMAT_COUNTS,
	PHOTO_COUNT,
	PHOTO_FIXTURE_FILE,
	SYNTHETIC_COVERAGE_DISTRIBUTIONS,
	validateFormatManifest,
	validatePhotoFixture,
} from "./native-migration-baseline.mjs";

const execFileAsync = promisify(execFile);
const fixture = createPhotoFixture();
const manifest = createFormatManifest();

function clone(value) {
	return structuredClone(value);
}

function rehash(document) {
	const { hash: _hash, ...payload } = document;
	document.hash = createHash("sha256")
		.update(`${JSON.stringify(payload)}\n`)
		.digest("hex");
	return document;
}

function counts(rows, field) {
	return rows.reduce((result, row) => {
		result[row[field]] = (result[row[field]] ?? 0) + 1;
		return result;
	}, {});
}

function assertNoPrivateMetadata(value, context = "document") {
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			assertNoPrivateMetadata(child, `${context}[${index}]`);
		});
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		assert.doesNotMatch(
			key,
			/(?:^|_)(?:file)?name$|path|gps|latitude|longitude|altitude/i,
			`${context}.${key}`,
		);
		if (typeof child === "string") {
			assert.doesNotMatch(
				child,
				/^(?:\/|[A-Za-z]:[\\/]|file:)/,
				`${context}.${key}`,
			);
		}
		assertNoPrivateMetadata(child, `${context}.${key}`);
	}
}

test("baseline generation is byte-for-byte deterministic and hashed", () => {
	const secondFixture = createPhotoFixture();
	const secondManifest = createFormatManifest();
	assert.equal(JSON.stringify(secondFixture), JSON.stringify(fixture));
	assert.equal(JSON.stringify(secondManifest), JSON.stringify(manifest));
	assert.match(fixture.hash, /^[a-f\d]{64}$/);
	assert.match(manifest.hash, /^[a-f\d]{64}$/);
	assert.equal(fixture.version, BASELINE_VERSION);
	assert.equal(manifest.version, BASELINE_VERSION);
	assert.equal(validatePhotoFixture(fixture), fixture);
	assert.equal(validateFormatManifest(manifest), manifest);
});

test("photo fixture pins count, formats, and synthetic null/status/date coverage", () => {
	assert.equal(fixture.photoCount, PHOTO_COUNT);
	assert.equal(fixture.photos.length, 7_961);
	assert.deepEqual(counts(fixture.photos, "format"), LIBRARY_FORMAT_COUNTS);
	assert.deepEqual(fixture.distributions, SYNTHETIC_COVERAGE_DISTRIBUTIONS);
	assert.deepEqual(
		{
			version: BASELINE_VERSION,
			photoCount: PHOTO_COUNT,
			libraryFormatCounts: LIBRARY_FORMAT_COUNTS,
			manifestFormatCounts: MANIFEST_FORMAT_COUNTS,
			manifestDngFailures: manifest.failureCount,
			syntheticDistributions: SYNTHETIC_COVERAGE_DISTRIBUTIONS,
		},
		NATIVE_MIGRATION_BASELINE_CONTRACT,
	);
	assert.equal(
		fixture.distributionEvidence,
		"synthetic-coverage-not-production-observation",
	);
});

test("fixture and manifest contain no filename, path, or GPS metadata", () => {
	assertNoPrivateMetadata(fixture);
	assertNoPrivateMetadata(manifest);
	const privatePath = clone(fixture);
	privatePath.photos[0].path = "/Users/someone/Pictures/private.jpg";
	rehash(privatePath);
	assert.throws(
		() => validatePhotoFixture(privatePath),
		/unexpected fields|private metadata|absolute path/,
	);
	const gps = clone(fixture);
	gps.photos[0].exif = { dateTaken: null, gpsLatitude: "1.23" };
	rehash(gps);
	assert.throws(
		() => validatePhotoFixture(gps),
		/unexpected fields|non-redacted EXIF|private metadata/,
	);
});

test("validators reject count, distribution, and content drift", () => {
	const missingPhoto = clone(fixture);
	missingPhoto.photos.pop();
	assert.throws(() => validatePhotoFixture(missingPhoto), /exactly 7961 rows/);
	const distributionDrift = clone(fixture);
	distributionDrift.distributions.exif.null--;
	distributionDrift.distributions.exif.present++;
	rehash(distributionDrift);
	assert.throws(
		() => validatePhotoFixture(distributionDrift),
		/distributions drifted/,
	);
	const contentDrift = clone(fixture);
	contentDrift.photos[0].format = "RAF";
	contentDrift.photos[0].raw.format = "RAF";
	rehash(contentDrift);
	assert.throws(
		() => validatePhotoFixture(contentDrift),
		/format counts drifted/,
	);
});

test("80-file manifest pins format counts and exactly three DNG failures", () => {
	assert.equal(manifest.fileCount, 80);
	assert.deepEqual(counts(manifest.files, "format"), MANIFEST_FORMAT_COUNTS);
	const failures = manifest.files.filter(
		(file) => file.expectedOutcome === "failure",
	);
	assert.equal(failures.length, 3);
	assert.ok(failures.every((file) => file.format === "DNG"));
	assert.ok(
		failures.every((file) => file.failureClass === "missing-embedded-preview"),
	);
	const lostFailure = clone(manifest);
	lostFailure.files.find(
		(file) => file.expectedOutcome === "failure",
	).expectedOutcome = "success";
	rehash(lostFailure);
	assert.throws(
		() => validateFormatManifest(lostFailure),
		/three failure cases/,
	);
});

test("Expo parity is declarative and includes each migration comparison surface", () => {
	assert.equal(EXPO_OBSERVABLE_PARITY.measurementClaim, null);
	assert.equal(EXPO_OBSERVABLE_PARITY.grid.phoneColumns, 5);
	assert.deepEqual(EXPO_OBSERVABLE_PARITY.grid.responsiveColumns, [5, 6, 7, 8]);
	assert.deepEqual(EXPO_OBSERVABLE_PARITY.chronology.dateFallbackOrder, [
		"exif.dateTaken",
		"modifiedAt",
		"createdAt",
	]);
	assert.equal(EXPO_OBSERVABLE_PARITY.chronology.defaultOrder, "oldest-first");
	for (const surface of [
		"selection",
		"filters",
		"search",
		"loupe",
		"scanCopy",
	]) {
		assert.ok(EXPO_OBSERVABLE_PARITY[surface]);
	}
	assert.equal(fixture.expoObservableParity, EXPO_OBSERVABLE_PARITY);
});

test("CLI writes deterministic artifacts and reports their hashes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "photobrain-baseline-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const script = new URL("./native-migration-baseline.mjs", import.meta.url);
	const first = await execFileAsync(
		process.execPath,
		[script.pathname, directory],
		{
			maxBuffer: 1024 * 1024,
		},
	);
	const firstPhotoBytes = await readFile(join(directory, PHOTO_FIXTURE_FILE));
	const firstManifestBytes = await readFile(
		join(directory, FORMAT_MANIFEST_FILE),
	);
	const second = await execFileAsync(
		process.execPath,
		[script.pathname, directory],
		{
			maxBuffer: 1024 * 1024,
		},
	);
	assert.deepEqual(
		await readFile(join(directory, PHOTO_FIXTURE_FILE)),
		firstPhotoBytes,
	);
	assert.deepEqual(
		await readFile(join(directory, FORMAT_MANIFEST_FILE)),
		firstManifestBytes,
	);
	assert.match(
		first.stdout,
		new RegExp(`Photo fixture SHA-256: ${fixture.hash}`),
	);
	assert.match(
		first.stdout,
		new RegExp(`Format manifest SHA-256: ${manifest.hash}`),
	);
	assert.equal(second.stdout, first.stdout);
});

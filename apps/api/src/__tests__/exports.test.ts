import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { photoExif, photos } from "../db/schema";
import { contentDisposition, createExportsRouter } from "../routes/exports";
import {
	addPhotosToCollection,
	type CollectionMember,
	createCollection,
} from "../services/collections";
import {
	collectionZipStream,
	type ExportRenderer,
	ZIP_LOOKAHEAD,
} from "../services/exports";
import { NativeExecutorBusyError } from "../services/native-executor";
import type { ApiDatabase } from "../services/photo-catalog";
import { dosDateTime, ZipWriter } from "../services/zip-writer";
import { createTestDb } from "./setup";

const encoder = new TextEncoder();
const MAX_U32 = 0xffffffff;
const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

let dir: string;
let photoDirectory: string;
let archives = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "photobrain-exports-"));
	photoDirectory = join(dir, "library");
	mkdirSync(photoDirectory);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Renders `jpeg <maxEdge> <file name>`; paths containing "corrupt" fail to
 * decode. A `gated` renderer holds each render until `release(index)` or
 * `releaseAll()`, and rejects a held render when its signal aborts, so tests
 * observe lookahead and cancellation through state, not elapsed time.
 */
function fakeRenderer(options: { gated?: boolean; busy?: boolean } = {}) {
	const calls: { path: string; maxEdge: number; quality: number }[] = [];
	const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
	const waiters = new Set<{ ready: () => boolean; resolve: () => void }>();
	let held = options.gated ?? false;
	let active = 0;
	let maxActive = 0;
	function notify() {
		for (const waiter of waiters) {
			if (!waiter.ready()) continue;
			waiters.delete(waiter);
			waiter.resolve();
		}
	}
	async function render(
		signal: AbortSignal | undefined,
		path: string,
		maxEdge: number,
		quality: number,
	) {
		signal?.throwIfAborted();
		calls.push({ path, maxEdge, quality });
		const gate = Promise.withResolvers<void>();
		gates.push(gate);
		active++;
		maxActive = Math.max(maxActive, active);
		notify();
		const onAbort = () => gate.reject(signal?.reason);
		try {
			if (held) {
				signal?.addEventListener("abort", onAbort, { once: true });
				await gate.promise;
			}
			if (path.includes("corrupt"))
				throw new Error("Failed to decode image:\n  corrupt data");
			return encoder.encode(`jpeg ${maxEdge} ${basename(path)}`);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			active--;
			notify();
		}
	}
	const renderer: ExportRenderer = {
		run: (_operation, path, maxEdge, quality) =>
			options.busy
				? Promise.reject(new NativeExecutorBusyError())
				: render(undefined, path, maxEdge, quality),
		runWhenAdmitted: (signal, _operation, path, maxEdge, quality) =>
			render(signal, path, maxEdge, quality),
	};
	return {
		renderer,
		calls,
		active: () => active,
		maxActive: () => maxActive,
		/** Resolves once `ready()` holds after a render starts or settles. */
		until(ready: () => boolean): Promise<void> {
			if (ready()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add({ ready, resolve });
			return promise;
		},
		release(index: number) {
			gates[index].resolve();
		},
		releaseAll() {
			held = false;
			for (const gate of gates) gate.resolve();
		},
	};
}

/** Writes `archive` to disk and runs Info-ZIP `unzip` on it, an independent reader. */
function unzip(archive: Uint8Array, args: string[], members: string[] = []) {
	const file = join(dir, `archive-${++archives}.zip`);
	writeFileSync(file, archive);
	const result = Bun.spawnSync(["unzip", ...args, file, ...members]);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		output: result.stdout.toString() + result.stderr.toString(),
	};
}

function expectValidZip(archive: Uint8Array) {
	const tested = unzip(archive, ["-t"]);
	expect(tested.output).toContain("No errors detected");
	expect(tested.exitCode).toBe(0);
}

function entryNames(archive: Uint8Array): string[] {
	const listed = unzip(archive, ["-Z1"]);
	expect(listed.exitCode).toBe(0);
	return listed.stdout.split("\n").filter(Boolean);
}

function entryText(archive: Uint8Array, name: string): string {
	const extracted = unzip(archive, ["-p"], [name]);
	expect(extracted.exitCode).toBe(0);
	return extracted.stdout;
}

describe("Content-Disposition", () => {
	test("non-ASCII, quotes, and backslashes fall back to _ and are percent-encoded as UTF-8", () => {
		expect(contentDisposition('Été "best"\\.jpg')).toBe(
			`attachment; filename="_t_ _best__.jpg"; filename*=UTF-8''%C3%89t%C3%A9%20%22best%22%5C.jpg`,
		);
	});

	test("an astral code point is one fallback character; control characters never reach the header", () => {
		expect(contentDisposition("📷\t\u0000\u007f.jpg")).toBe(
			`attachment; filename="____.jpg"; filename*=UTF-8''%F0%9F%93%B7%09%00%7F.jpg`,
		);
	});

	test("RFC 5987 encoding escapes the characters encodeURIComponent leaves bare", () => {
		expect(contentDisposition("it's (1)*.jpg")).toBe(
			`attachment; filename="it's (1)*.jpg"; filename*=UTF-8''it%27s%20%281%29%2A.jpg`,
		);
	});
});

describe("ZIP writer", () => {
	const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 7));

	test("DOS times use UTC fields at two-second precision and clamp to the representable range", () => {
		expect(dosDateTime(date)).toEqual({
			date: (44 << 9) | (1 << 5) | 2,
			time: (3 << 11) | (4 << 5) | 3,
		});
		expect(dosDateTime(new Date(Date.UTC(1979, 11, 31, 23, 59, 59)))).toEqual({
			date: (1 << 5) | 1,
			time: 0,
		});
		expect(dosDateTime(new Date(Date.UTC(2108, 0, 1)))).toEqual({
			date: (127 << 9) | (12 << 5) | 31,
			time: (23 << 11) | (59 << 5) | 29,
		});
		expect(dosDateTime(new Date(Number.NaN))).toEqual({
			date: (1 << 5) | 1,
			time: 0,
		});
	});

	test("rejects names that are empty or longer than the 16-bit length field", () => {
		const writer = new ZipWriter();
		expect(() => writer.entry("", new Uint8Array(), date)).toThrow(RangeError);
		expect(() =>
			writer.entry("é".repeat(32_768), new Uint8Array(), date),
		).toThrow(RangeError);
		expect(
			writer.entry("é".repeat(32_767), new Uint8Array(), date),
		).toHaveLength(2);
	});

	// Listings use "é" (C3 A9): Apple's unzip display-escapes UTF-8 bytes in
	// 0x80-0x9F (as in "É", C3 89) even when the stored name is correct, which
	// `unzip -p` extraction by the exact UTF-8 name still proves.
	test("a classic archive round-trips through unzip with UTF-8 names, CRCs, and times", () => {
		const writer = new ZipWriter();
		const parts = [
			...writer.entry("été.txt", encoder.encode("hello"), date),
			...writer.entry("Été 📷.txt", encoder.encode("astral"), date),
			...writer.entry("empty.bin", new Uint8Array(), date),
			writer.finish(),
		];
		const archive = Buffer.concat(parts);
		expectValidZip(archive);
		expect(entryNames(archive)).toHaveLength(3);
		expect(entryNames(archive)[0]).toBe("été.txt");
		expect(entryText(archive, "été.txt")).toBe("hello");
		expect(entryText(archive, "Été 📷.txt")).toBe("astral");
		expect(unzip(archive, ["-Z", "-T"]).stdout).toContain(
			"20240102.030406 été.txt",
		);
		expect(() => writer.finish()).toThrow("already finished");
		expect(() => writer.entry("late", new Uint8Array(), date)).toThrow(
			"already finished",
		);
	});

	test("offsets past 4 GiB move into ZIP64 central extras and end records", () => {
		const start = 2 ** 32;
		const writer = new ZipWriter(start);
		const [local] = writer.entry("late.txt", encoder.encode("hi"), date);
		const tail = writer.finish();
		const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
		// Central record: classic sizes, saturated offset, one-field ZIP64 extra.
		expect(view.getUint32(0, true)).toBe(0x02014b50);
		expect(view.getUint16(6, true)).toBe(45);
		expect(view.getUint32(20, true)).toBe(2);
		expect(view.getUint32(42, true)).toBe(MAX_U32);
		expect(view.getUint16(30, true)).toBe(12);
		const extra = 46 + "late.txt".length;
		expect(view.getUint16(extra, true)).toBe(1);
		expect(view.getUint16(extra + 2, true)).toBe(8);
		expect(view.getBigUint64(extra + 4, true)).toBe(BigInt(start));

		const directoryOffset = start + local.byteLength + 2;
		const directorySize = extra + 12;
		const zip64End = directorySize;
		expect(view.getUint32(zip64End, true)).toBe(0x06064b50);
		expect(view.getBigUint64(zip64End + 24, true)).toBe(1n);
		expect(view.getBigUint64(zip64End + 40, true)).toBe(BigInt(directorySize));
		expect(view.getBigUint64(zip64End + 48, true)).toBe(
			BigInt(directoryOffset),
		);
		const locator = zip64End + 56;
		expect(view.getUint32(locator, true)).toBe(0x07064b50);
		expect(view.getBigUint64(locator + 8, true)).toBe(
			BigInt(directoryOffset + directorySize),
		);
		const end = locator + 20;
		expect(end + 22).toBe(tail.byteLength);
		expect(view.getUint32(end, true)).toBe(0x06054b50);
		expect(view.getUint16(end + 10, true)).toBe(1);
		expect(view.getUint32(end + 16, true)).toBe(MAX_U32);
	});

	test("sizes of 4 GiB or more are carried in local and central ZIP64 extras", () => {
		const writer = new ZipWriter();
		const size = 2 ** 32 + 7;
		const local = writer.header("huge.bin", size, 0x1234abcd, date);
		const localView = new DataView(local.buffer);
		expect(localView.getUint16(4, true)).toBe(45);
		expect(localView.getUint32(14, true)).toBe(0x1234abcd);
		expect(localView.getUint32(18, true)).toBe(MAX_U32);
		expect(localView.getUint32(22, true)).toBe(MAX_U32);
		expect(localView.getUint16(28, true)).toBe(20);
		const localExtra = 30 + "huge.bin".length;
		expect(localView.getUint16(localExtra, true)).toBe(1);
		expect(localView.getBigUint64(localExtra + 4, true)).toBe(BigInt(size));
		expect(localView.getBigUint64(localExtra + 12, true)).toBe(BigInt(size));

		// The next entry starts past 4 GiB: its offset needs ZIP64 too.
		writer.header("after.bin", 0, 0, date);
		const tail = writer.finish();
		const view = new DataView(tail.buffer);
		const firstExtra = 46 + "huge.bin".length;
		expect(view.getUint16(30, true)).toBe(20);
		expect(view.getUint32(42, true)).toBe(0);
		expect(view.getBigUint64(firstExtra + 4, true)).toBe(BigInt(size));
		expect(view.getBigUint64(firstExtra + 12, true)).toBe(BigInt(size));
		const second = firstExtra + 20;
		expect(view.getUint32(second, true)).toBe(0x02014b50);
		expect(view.getUint32(second + 20, true)).toBe(0);
		expect(view.getUint32(second + 42, true)).toBe(MAX_U32);
		expect(view.getBigUint64(second + 46 + "after.bin".length + 4, true)).toBe(
			BigInt(local.byteLength + size),
		);
	});

	test("65,534 entries keep classic end records; more need ZIP64 and still pass unzip", () => {
		const classic = new ZipWriter();
		for (let index = 0; index < 65_534; index++) {
			classic.entry(`${index}`, new Uint8Array(), date);
		}
		const classicTail = classic.finish();
		const classicView = new DataView(classicTail.buffer);
		const classicEnd = classicTail.byteLength - 22;
		expect(classicView.getUint16(classicEnd + 10, true)).toBe(65_534);
		expect(classicView.getUint32(classicEnd - 20, true)).not.toBe(0x07064b50);

		const count = 65_537;
		const writer = new ZipWriter();
		const parts: Uint8Array[] = [];
		for (let index = 0; index < count; index++) {
			parts.push(
				...writer.entry(`f${index}`, Uint8Array.of(index & 0xff), date),
			);
		}
		parts.push(writer.finish());
		const archive = Buffer.concat(parts);
		const end = new DataView(archive.buffer, archive.byteOffset).getUint16(
			archive.byteLength - 22 + 10,
			true,
		);
		expect(end).toBe(0xffff);
		expectValidZip(archive);
		const names = entryNames(archive);
		expect(names).toHaveLength(count);
		expect(names.at(-1)).toBe(`f${count - 1}`);
	}, 30_000);
});

describe("export routes", () => {
	let database: ApiDatabase;

	beforeEach(() => {
		database = createTestDb().db;
	});

	function addPhoto(fields: {
		name: string;
		path?: string;
		contents?: string | null;
		mimeType?: string | null;
		sourceRoot?: string;
		modifiedAt?: Date;
		dateTaken?: string;
	}): number {
		const path = fields.path ?? fields.name;
		const root = fields.sourceRoot ?? photoDirectory;
		if (fields.contents !== null) {
			const file = join(root, path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, fields.contents ?? `bytes of ${path}`);
		}
		const photo = database
			.insert(photos)
			.values({
				path,
				name: fields.name,
				size: 1,
				createdAt: new Date(0),
				modifiedAt: fields.modifiedAt ?? new Date(Date.UTC(2024, 5, 1)),
				mimeType:
					fields.mimeType === undefined ? "image/jpeg" : fields.mimeType,
				sourceRoot: fields.sourceRoot ?? null,
			})
			.returning()
			.get();
		if (fields.dateTaken) {
			database
				.insert(photoExif)
				.values({ photoId: photo.id, dateTaken: fields.dateTaken })
				.run();
		}
		return photo.id;
	}

	function app(renderer = fakeRenderer().renderer) {
		const hono = new Hono();
		hono.route(
			"/api",
			createExportsRouter({ database, photoDirectory, renderer }),
		);
		return hono;
	}

	async function errorOf(response: Response) {
		expect(response.headers.get("Content-Type")).toContain("application/json");
		return errorBodySchema.parse(await response.json()).error.code;
	}

	async function zipOf(response: Response) {
		expect(response.status).toBe(200);
		return new Uint8Array(await response.arrayBuffer());
	}

	describe("single photo", () => {
		test("original streams the exact bytes with its MIME type and RFC 6266 filename", async () => {
			const id = addPhoto({
				name: 'Été "best".heic',
				contents: "heic bytes",
				mimeType: "image/heic",
			});
			const response = await app().request(
				`/api/photos/${id}/export?size=original`,
			);
			expect(response.status).toBe(200);
			expect(Object.fromEntries(response.headers)).toMatchObject({
				"content-type": "image/heic",
				"content-length": "10",
				"cache-control": "private, no-store",
				"content-disposition": `attachment; filename="_t_ _best_.heic"; filename*=UTF-8''%C3%89t%C3%A9%20%22best%22.heic`,
			});
			expect(await response.text()).toBe("heic bytes");
		});

		test("original without a recorded MIME type is octet-stream", async () => {
			const id = addPhoto({ name: "raw.arw", mimeType: null });
			const response = await app().request(
				`/api/photos/${id}/export?size=original`,
			);
			expect(response.headers.get("Content-Type")).toBe(
				"application/octet-stream",
			);
		});

		test("defaults to a 2048 JPEG rendered at quality 90 from the committed source root", async () => {
			const otherRoot = join(dir, "other-root");
			const id = addPhoto({
				name: "trip.photo.HEIC",
				path: "2024/trip.photo.HEIC",
				sourceRoot: otherRoot,
			});
			const fake = fakeRenderer();
			const response = await app(fake.renderer).request(
				`/api/photos/${id}/export`,
			);
			expect(response.status).toBe(200);
			expect(fake.calls).toEqual([
				{
					path: join(otherRoot, "2024/trip.photo.HEIC"),
					maxEdge: 2048,
					quality: 90,
				},
			]);
			const body = await response.text();
			expect(body).toBe("jpeg 2048 trip.photo.HEIC");
			expect(Object.fromEntries(response.headers)).toMatchObject({
				"content-type": "image/jpeg",
				"content-length": String(body.length),
				"cache-control": "private, no-store",
				"content-disposition": `attachment; filename="trip.photo_2048.jpg"; filename*=UTF-8''trip.photo_2048.jpg`,
			});
		});

		test("1024 renders at that edge", async () => {
			const id = addPhoto({ name: "a.jpg" });
			const fake = fakeRenderer();
			const response = await app(fake.renderer).request(
				`/api/photos/${id}/export?size=1024`,
			);
			expect(await response.text()).toBe("jpeg 1024 a.jpg");
			expect(response.headers.get("Content-Disposition")).toContain(
				'filename="a_1024.jpg"',
			);
		});

		test.each([
			["abc", "2048"],
			["0", "2048"],
			["-1", "2048"],
			["1.5", "2048"],
			["1", "4096"],
			["1", ""],
			["1", "ORIGINAL"],
		])("id %p size %p is INVALID_REQUEST", async (id, size) => {
			addPhoto({ name: "a.jpg" });
			const response = await app().request(
				`/api/photos/${id}/export?size=${size}`,
			);
			expect(response.status).toBe(400);
			expect(await errorOf(response)).toBe("INVALID_REQUEST");
		});

		test("an unknown photo is PHOTO_NOT_FOUND", async () => {
			const response = await app().request("/api/photos/999/export");
			expect(response.status).toBe(404);
			expect(await errorOf(response)).toBe("PHOTO_NOT_FOUND");
		});

		test.each([
			"original",
			"2048",
		])("a missing source is SOURCE_MISSING for size %s without rendering", async (size) => {
			const id = addPhoto({ name: "gone.jpg", contents: null });
			const fake = fakeRenderer();
			const response = await app(fake.renderer).request(
				`/api/photos/${id}/export?size=${size}`,
			);
			expect(response.status).toBe(404);
			expect(await errorOf(response)).toBe("SOURCE_MISSING");
			expect(fake.calls).toEqual([]);
		});

		test("a decode failure is EXPORT_FAILED", async () => {
			const id = addPhoto({ name: "corrupt.jpg" });
			const response = await app().request(`/api/photos/${id}/export`);
			expect(response.status).toBe(422);
			expect(await errorOf(response)).toBe("EXPORT_FAILED");
		});

		test("a full executor is a retryable EXPORT_BUSY", async () => {
			const id = addPhoto({ name: "a.jpg" });
			const response = await app(fakeRenderer({ busy: true }).renderer).request(
				`/api/photos/${id}/export`,
			);
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await errorOf(response)).toBe("EXPORT_BUSY");
		});
	});

	describe("collection ZIP", () => {
		function collect(name: string, ids: number[]) {
			const collection = createCollection(database, name);
			if (ids.length) addPhotosToCollection(database, collection.id, ids);
			return collection.id;
		}

		test("streams originals in captured order with headers, contents, and mtimes; RAW+JPEG pairs are not stacked", async () => {
			const late = addPhoto({
				name: "late.jpg",
				contents: "late",
				dateTaken: "2024:06:15 12:00:00",
			});
			const raw = addPhoto({
				name: "pair.ARW",
				contents: "raw",
				mimeType: "image/x-sony-arw",
				dateTaken: "2023:01:01 08:00:00",
			});
			const jpeg = addPhoto({
				name: "pair.JPG",
				contents: "jpeg",
				dateTaken: "2023:01:01 08:00:00",
			});
			// No capture date: ordered by modifiedAt (2020) before both.
			const undated = addPhoto({
				name: "été.png",
				contents: "png",
				modifiedAt: new Date(Date.UTC(2020, 1, 3, 4, 5, 6)),
			});
			const id = collect('Trip "Ünïcode"', [late, jpeg, undated, raw]);
			const response = await app().request(`/api/collections/${id}/export`);
			expect(Object.fromEntries(response.headers)).toMatchObject({
				"content-type": "application/zip",
				"cache-control": "private, no-store",
				"content-disposition": `attachment; filename="Trip __n_code_.zip"; filename*=UTF-8''Trip%20%22%C3%9Cn%C3%AFcode%22.zip`,
			});
			expect(response.headers.get("Content-Length")).toBeNull();
			const archive = await zipOf(response);
			expectValidZip(archive);
			expect(entryNames(archive)).toEqual([
				"été.png",
				"pair.ARW",
				"pair.JPG",
				"late.jpg",
			]);
			expect(entryText(archive, "pair.ARW")).toBe("raw");
			expect(entryText(archive, "late.jpg")).toBe("late");
			expect(unzip(archive, ["-Z", "-T"]).stdout).toContain(
				"20200203.040506 été.png",
			);
		});

		test("rendered sizes use per-photo JPEG names, disambiguated case-insensitively", async () => {
			const ids = [
				addPhoto({
					name: "IMG.heic",
					path: "a/IMG.heic",
					dateTaken: "2024:01:01 00:00:01",
				}),
				addPhoto({
					name: "img.jpg",
					path: "b/img.jpg",
					dateTaken: "2024:01:01 00:00:02",
				}),
				addPhoto({
					name: "Img.png",
					path: "c/Img.png",
					dateTaken: "2024:01:01 00:00:03",
				}),
				addPhoto({
					name: "img_1024 (2).jpg",
					path: "d/x.jpg",
					dateTaken: "2024:01:01 00:00:04",
				}),
			];
			const id = collect("Renders", ids);
			const fake = fakeRenderer();
			const archive = await zipOf(
				await app(fake.renderer).request(
					`/api/collections/${id}/export?size=1024`,
				),
			);
			expectValidZip(archive);
			expect(entryNames(archive)).toEqual([
				"IMG_1024.jpg",
				"img_1024 (2).jpg",
				"Img_1024 (3).jpg",
				"img_1024 (2)_1024.jpg",
			]);
			expect(entryText(archive, "Img_1024 (3).jpg")).toBe("jpeg 1024 Img.png");
			expect(fake.calls.every((call) => call.quality === 90)).toBe(true);
		});

		test("duplicate originals keep their extension and case", async () => {
			const ids = ["a.jpg", "A.JPG", "a.jpg"].map((name, index) =>
				addPhoto({
					name,
					path: `${index}/${name}`,
					dateTaken: `2024:01:0${index + 1} 00:00:00`,
				}),
			);
			const archive = await zipOf(
				await app().request(`/api/collections/${collect("Dupes", ids)}/export`),
			);
			expect(entryNames(archive)).toEqual(["a.jpg", "A (2).JPG", "a (3).jpg"]);
		});

		test.each([
			["original", ["ok.jpg"], "gone.jpg: source file missing\n"],
			[
				"2048",
				["ok_2048.jpg"],
				"gone_2048.jpg: source file missing\ncorrupt_2048.jpg: export failed: Failed to decode image: corrupt data\n",
			],
		])("size %s skips failed members and lists them in export-errors.txt", async (size, kept, errors) => {
			const ids = [
				addPhoto({
					name: "gone.jpg",
					contents: null,
					dateTaken: "2024:01:01 00:00:00",
				}),
				addPhoto({ name: "corrupt.jpg", dateTaken: "2024:01:02 00:00:00" }),
				addPhoto({ name: "ok.jpg", dateTaken: "2024:01:03 00:00:00" }),
			];
			const id = collect(
				"Partial",
				size === "original" ? [ids[0], ids[2]] : ids,
			);
			const archive = await zipOf(
				await app().request(`/api/collections/${id}/export?size=${size}`),
			);
			expectValidZip(archive);
			expect(entryNames(archive)).toEqual([...kept, "export-errors.txt"]);
			expect(entryText(archive, "export-errors.txt")).toBe(errors);
		});

		test("an empty collection is a valid empty ZIP", async () => {
			const archive = await zipOf(
				await app().request(`/api/collections/${collect("Empty", [])}/export`),
			);
			expect([...archive]).toEqual([
				0x50,
				0x4b,
				5,
				6,
				...new Array(18).fill(0),
			]);
			// Info-ZIP recognises it and reports it empty, not damaged.
			expect(unzip(archive, ["-t"]).output).toContain("zipfile is empty");
		});

		test("an unknown collection is COLLECTION_NOT_FOUND", async () => {
			const response = await app().request("/api/collections/999/export");
			expect(response.status).toBe(404);
			expect(await errorOf(response)).toBe("COLLECTION_NOT_FOUND");
		});

		test.each([
			["x", "original"],
			["0", "original"],
			["1", "512"],
		])("id %p size %p is INVALID_REQUEST", async (id, size) => {
			collect("Some", []);
			const response = await app().request(
				`/api/collections/${id}/export?size=${size}`,
			);
			expect(response.status).toBe(400);
			expect(await errorOf(response)).toBe("INVALID_REQUEST");
		});
	});
});

describe("collection ZIP stream", () => {
	function members(count: number): CollectionMember[] {
		return Array.from({ length: count }, (_, index) => {
			const path = `${index}.jpg`;
			writeFileSync(join(photoDirectory, path), "source");
			return {
				id: index + 1,
				name: path,
				path,
				sourceRoot: null,
				mimeType: "image/jpeg",
				modifiedAt: new Date(Date.UTC(2024, 0, 1)),
			};
		});
	}

	test("renders at most the lookahead ahead of the consumer", async () => {
		const fake = fakeRenderer({ gated: true });
		const reader = collectionZipStream(members(8), {
			size: "1024",
			photoDirectory,
			renderer: fake.renderer,
		}).getReader();
		const header = reader.read();
		await fake.until(() => fake.active() === ZIP_LOOKAHEAD);
		expect(fake.calls).toHaveLength(ZIP_LOOKAHEAD);
		fake.release(0);
		expect((await header).done).toBe(false);
		// Writing the first entry admits exactly one more member.
		await fake.until(() => fake.calls.length === 1 + ZIP_LOOKAHEAD);
		expect(fake.active()).toBe(ZIP_LOOKAHEAD);
		fake.releaseAll();
		let chunks = 1;
		while (!(await reader.read()).done) chunks++;
		// Eight entries of header + data, then the central directory.
		expect(chunks).toBe(17);
		expect(fake.calls).toHaveLength(8);
		expect(fake.maxActive()).toBe(ZIP_LOOKAHEAD);
	});

	test.each([
		"cancel",
		"abort",
	])("client %s stops renders within one entry", async (stop) => {
		const fake = fakeRenderer({ gated: true });
		const abort = new AbortController();
		const reader = collectionZipStream(members(20), {
			size: "2048",
			photoDirectory,
			renderer: fake.renderer,
			signal: abort.signal,
		}).getReader();
		const header = reader.read();
		await fake.until(() => fake.active() === ZIP_LOOKAHEAD);
		fake.release(0);
		await header;
		await reader.read(); // the first entry's data
		await fake.until(() => fake.calls.length === 1 + ZIP_LOOKAHEAD);
		if (stop === "cancel") {
			await reader.cancel();
		} else {
			const pending = reader.read();
			abort.abort(new Error("client went away"));
			await expect(pending).rejects.toThrow("client went away");
		}
		// The in-flight renders are withdrawn and nothing new starts.
		await fake.until(() => fake.active() === 0);
		expect(fake.calls).toHaveLength(1 + ZIP_LOOKAHEAD);
	});
});

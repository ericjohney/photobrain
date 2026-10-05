import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	mock,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseConfig } from "../config";
import { scanJobs, uploadAssets, uploads } from "../db/schema";
import { createUploadsRouter } from "../routes/uploads";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	cleanIncomingUploads,
	type MediaSupport,
	sanitizePathSegment,
} from "../services/uploads";
import { createTestDb } from "./setup";

const DEVICE = "0F8FAD5B-D9CB-469F-A165-70867728950E";
const OTHER_DEVICE = "7C9E6679-7425-40DE-944B-E07FC1F90AE7";
const MAX_BYTES = 1024 * 1024;
const GiB = 1024 ** 3;

type UploadFunction = {
	options: { id: string; debounce: { period: string } };
	trigger: { event: string };
	handler(context: {
		event: { data: Record<string, never> };
		step: { run<T>(id: string, work: () => Promise<T>): Promise<T> };
	}): Promise<{ success: boolean; jobId: string }>;
};

// The Inngest function test mocks ../db, ../config and the Inngest client
// process-wide, so it runs in an isolated child like the events suite.
if (process.env.PHOTOBRAIN_UPLOADS_TEST_CHILD === "1") {
	test("scan-after-upload-v1 debounces photos/uploaded into the shared incremental startScan", async () => {
		const { db } = createTestDb();
		const sent: unknown[] = [];
		mock.module("../db", () => ({ db }));
		// `../inngest` reaches tag-labels, which value-imports the native addon;
		// CI's API job does not build it.
		mock.module("@photobrain/image-processing", () => ({
			clipTextEmbedding: () => [1, 0, 0, 0],
		}));
		mock.module("../config", () => ({
			config: {
				PHOTO_DIRECTORY: "/library/photos",
				THUMBNAILS_DIRECTORY: "/library/thumbnails",
			},
		}));
		mock.module("../inngest/client", () => ({
			inngest: {
				send: async (event: unknown) => {
					sent.push(event);
				},
				createFunction: (
					options: unknown,
					trigger: unknown,
					handler: UploadFunction["handler"],
				) => ({ options, trigger, handler }),
			},
		}));
		// Dynamic: these modules must load after the mock.module calls above.
		const { scanAfterUploadFunction } = await import(
			"../inngest/functions/uploads"
		);
		const { functions } = await import("../inngest");
		expect(functions).toContain(scanAfterUploadFunction);
		const fn = scanAfterUploadFunction as unknown as UploadFunction;
		expect(fn.options).toEqual({
			id: "scan-after-upload-v1",
			debounce: { period: "60s" },
		});
		expect(fn.trigger).toEqual({ event: "photos/uploaded" });

		const steps: string[] = [];
		const result = await fn.handler({
			event: { data: {} },
			step: {
				run: async (id, work) => {
					steps.push(id);
					return work();
				},
			},
		});
		expect(steps).toEqual(["start-scan-after-upload-v1"]);
		expect(result.success).toBe(true);
		expect(sent).toEqual([
			{
				id: result.jobId,
				name: "photos/scan.requested",
				data: {
					directory: resolve("/library/photos"),
					thumbnailsDir: resolve("/library/thumbnails"),
					jobId: result.jobId,
					force: false,
				},
			},
		]);
		const job = db
			.select()
			.from(scanJobs)
			.where(eq(scanJobs.id, result.jobId))
			.get();
		expect(job?.status).toBe("queued");
	});
} else {
	test("scan-after-upload-v1 (isolated child)", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_UPLOADS_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
	}, 60_000);

	const media: MediaSupport = {
		isSupportedMedia: (file) => /\.(jpe?g|heic|mov|dng)$/i.test(file),
		getSupportedExtensions: () => [".jpg", ".jpeg", ".HEIC", ".mov", ".dng"],
	};

	/** A body that counts pulls, so tests can prove it was never read. */
	function trackedBody(bytes: Uint8Array, chunkSize = 4096) {
		const state = { pulls: 0 };
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					state.pulls++;
					if (offset >= bytes.byteLength) {
						controller.close();
						return;
					}
					controller.enqueue(bytes.slice(offset, offset + chunkSize));
					offset += chunkSize;
				},
			},
			{ highWaterMark: 0 },
		);
		return { stream, state };
	}

	function bytesOf(text: string, repeat = 1) {
		return new TextEncoder().encode(text.repeat(repeat));
	}

	describe("phone backup uploads", () => {
		let root: string;
		let database: ApiDatabase;
		let notifyUploaded: Mock<() => Promise<unknown>>;
		let freeBytes: number;
		let app: Hono;

		function createApp(enabled = true) {
			const created = new Hono();
			created.route(
				"/api/v1/uploads",
				createUploadsRouter({
					database,
					photoDirectory: root,
					enabled,
					maxBytes: MAX_BYTES,
					media,
					freeBytes: async () => freeBytes,
					notifyUploaded,
					now: () => new Date(2026, 9, 4, 12, 0, 0),
				}),
			);
			return created;
		}

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "photobrain-uploads-"));
			database = createTestDb().db;
			notifyUploaded = mock(async () => undefined);
			freeBytes = 100 * GiB;
			app = createApp();
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		type Query = Record<string, string | undefined>;

		function upload(
			query: Query,
			body: Uint8Array | ReadableStream<Uint8Array>,
			contentLength: number | null = body instanceof Uint8Array
				? body.byteLength
				: null,
			target = app,
		) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) params.set(key, value);
			}
			const headers = new Headers({
				"Content-Type": "application/octet-stream",
			});
			if (contentLength !== null) {
				headers.set("Content-Length", String(contentLength));
			}
			return target.request(
				new Request(`http://localhost/api/v1/uploads?${params}`, {
					method: "POST",
					headers,
					body,
					duplex: "half",
				} as RequestInit),
			);
		}

		const base = (overrides: Query = {}): Query => ({
			deviceId: DEVICE,
			deviceName: "Eric's iPhone",
			filename: "IMG_0001.HEIC",
			...overrides,
		});

		function libraryFiles(directory = join(root, "Uploads")): string[] {
			if (!existsSync(directory)) return [];
			return readdirSync(directory, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) =>
					join(entry.parentPath, entry.name).slice(root.length + 1),
				)
				.filter((file) => !file.startsWith("Uploads/.incoming/"))
				.sort();
		}

		function incomingFiles() {
			const incoming = join(root, "Uploads", ".incoming");
			return existsSync(incoming) ? readdirSync(incoming) : [];
		}

		async function json(response: Response) {
			return (await response.json()) as Record<string, unknown>;
		}

		function known(deviceId: string, assetIds: string[], target = app) {
			return target.request("/api/v1/uploads/known", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ deviceId, assetIds }),
			});
		}

		test("config parsing: uploads default off and 10 GiB, explicit values parse", () => {
			const defaults = parseConfig({});
			expect(defaults.UPLOADS_ENABLED).toBe(false);
			expect(defaults.UPLOAD_MAX_BYTES).toBe(10_737_418_240);
			expect(parseConfig({ UPLOADS_ENABLED: "1" }).UPLOADS_ENABLED).toBe(true);
			expect(parseConfig({ UPLOADS_ENABLED: "true" }).UPLOADS_ENABLED).toBe(
				true,
			);
			expect(parseConfig({ UPLOADS_ENABLED: "0" }).UPLOADS_ENABLED).toBe(false);
			expect(
				parseConfig({ UPLOAD_MAX_BYTES: "1048576" }).UPLOAD_MAX_BYTES,
			).toBe(1_048_576);
			const error = console.error;
			console.error = () => undefined;
			try {
				expect(() => parseConfig({ UPLOADS_ENABLED: "yes" })).toThrow();
				expect(() => parseConfig({ UPLOAD_MAX_BYTES: "0" })).toThrow();
				expect(() => parseConfig({ UPLOAD_MAX_BYTES: "1.5" })).toThrow();
			} finally {
				console.error = error;
			}
		});

		test("GET /config is always available and lower-cases native extensions", async () => {
			for (const enabled of [true, false]) {
				const response = await createApp(enabled).request(
					"/api/v1/uploads/config",
				);
				expect(response.status).toBe(200);
				expect(await json(response)).toEqual({
					enabled,
					maxBytes: MAX_BYTES,
					extensions: [".jpg", ".jpeg", ".heic", ".mov", ".dng"],
				});
			}
		});

		test("disabled: 503 before reading the body or checking anything else", async () => {
			const disabled = createApp(false);
			const { stream, state } = trackedBody(bytesOf("x", 10));
			// No Content-Length and invalid params: the disabled check still wins.
			const response = await upload(
				{ deviceId: "nope" },
				stream,
				null,
				disabled,
			);
			expect(response.status).toBe(503);
			expect(await json(response)).toEqual({
				error: { code: "UPLOADS_DISABLED", message: "Uploads are disabled" },
			});
			expect(state.pulls).toBe(0);
			const knownResponse = await known(DEVICE, ["a"], disabled);
			expect(knownResponse.status).toBe(503);
			expect(existsSync(join(root, "Uploads"))).toBe(false);
		});

		test("length checks: 411 without Content-Length, 413 above maxBytes, both unread", async () => {
			const missing = trackedBody(bytesOf("x", 10));
			const noLength = await upload(base(), missing.stream, null);
			expect(noLength.status).toBe(411);
			expect((await json(noLength)).error).toMatchObject({
				code: "LENGTH_REQUIRED",
			});
			expect(missing.state.pulls).toBe(0);

			const large = trackedBody(bytesOf("x", 10));
			const tooLarge = await upload(base(), large.stream, MAX_BYTES + 1);
			expect(tooLarge.status).toBe(413);
			expect((await json(tooLarge)).error).toMatchObject({
				code: "UPLOAD_TOO_LARGE",
			});
			expect(large.state.pulls).toBe(0);
			expect(libraryFiles()).toEqual([]);
			expect(notifyUploaded).not.toHaveBeenCalled();
		});

		test("415 for unsupported extensions without reading; 507 below the free-space margin", async () => {
			for (const filename of ["notes.txt", "IMG_0001", "clip.avi", "..jpg"]) {
				const body = trackedBody(bytesOf("x", 10));
				const response = await upload(base({ filename }), body.stream, 10);
				expect(response.status).toBe(415);
				expect((await json(response)).error).toMatchObject({
					code: "UNSUPPORTED_MEDIA",
				});
				expect(body.state.pulls).toBe(0);
			}

			freeBytes = GiB + 99;
			const body = trackedBody(bytesOf("x", 100));
			const full = await upload(base(), body.stream, 100);
			expect(full.status).toBe(507);
			expect((await json(full)).error).toMatchObject({
				code: "INSUFFICIENT_STORAGE",
			});
			expect(body.state.pulls).toBe(0);
			freeBytes = GiB + 100;
			expect((await upload(base(), bytesOf("x", 100))).status).toBe(201);
			expect(incomingFiles()).toEqual([]);
		});

		test("parameter validation returns 400 INVALID_REQUEST", async () => {
			const cases: Query[] = [
				base({ deviceId: undefined }),
				base({ deviceId: "not-a-uuid" }),
				base({ deviceName: undefined }),
				base({ deviceName: "   " }),
				base({ deviceName: "d".repeat(65) }),
				base({ filename: "" }),
				base({ filename: `${"f".repeat(252)}.jpg` }),
				base({ assetId: "asset" }),
				base({ resource: "photo" }),
				base({ assetId: "asset", resource: "livePhoto" }),
				base({ assetId: "a".repeat(257), resource: "photo" }),
				base({ assetId: "", resource: "photo" }),
				base({ capturedAt: "2026-10-03T23:30:00" }),
				base({ capturedAt: "yesterday" }),
			];
			for (const query of cases) {
				const response = await upload(query, bytesOf("x", 5));
				expect({ query, status: response.status }).toEqual({
					query,
					status: 400,
				});
				expect(await json(response)).toEqual({
					error: {
						code: "INVALID_REQUEST",
						message: "Request validation failed",
					},
				});
			}
			const empty = await upload(base(), new Uint8Array(0), 0);
			expect(empty.status).toBe(400);
			// Boundary values are accepted.
			const accepted = await upload(
				base({
					deviceName: ` ${"d".repeat(64)} `,
					filename: `${"f".repeat(251)}.jpg`,
					assetId: "a".repeat(256),
					resource: "photo",
				}),
				bytesOf("ok"),
			);
			expect(accepted.status).toBe(201);
			expect(libraryFiles()).toHaveLength(1);
		});

		test("created: path layout uses capturedAt's own local month and sets mtime", async () => {
			// 00:30 on Jan 1 in UTC+9 is still Dec 31 in UTC: the folder is 2026/01.
			const capturedAt = "2026-01-01T00:30:00+09:00";
			const bytes = bytesOf("heic-bytes", 1000);
			const response = await upload(base({ capturedAt }), bytes);
			expect(response.status).toBe(201);
			const body = await json(response);
			expect(body).toEqual({
				status: "created",
				path: "Uploads/Eric's iPhone/2026/01/IMG_0001.HEIC",
				size: bytes.byteLength,
			});
			const file = join(root, body.path as string);
			expect(readFileSync(file)).toEqual(Buffer.from(bytes));
			expect(statSync(file).mtimeMs).toBe(Date.parse(capturedAt));
			const [row] = database.select().from(uploads).all();
			expect(row).toMatchObject({
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				size: bytes.byteLength,
				relativePath: body.path,
				deviceId: DEVICE.toLowerCase(),
			});
			expect(incomingFiles()).toEqual([]);

			// A "+" decoded as a space before the offset is restored.
			const westward = await upload(
				base({
					filename: "IMG_0002.HEIC",
					capturedAt: "2025-12-31T23:30:00-05:00",
				}),
				bytesOf("west"),
			);
			expect((await json(westward)).path).toBe(
				"Uploads/Eric's iPhone/2025/12/IMG_0002.HEIC",
			);
			const plusAsSpace = await app.request(
				`/api/v1/uploads?deviceId=${DEVICE}&deviceName=Phone&filename=p.jpg&capturedAt=2026-03-01T01:00:00+02:00`,
				{
					method: "POST",
					headers: { "Content-Length": "4" },
					body: bytesOf("plus"),
				},
			);
			expect(plusAsSpace.status).toBe(201);
			const plusPath = (await json(plusAsSpace)).path as string;
			expect(plusPath).toBe("Uploads/Phone/2026/03/p.jpg");
			expect(statSync(join(root, plusPath)).mtimeMs).toBe(
				Date.parse("2026-03-01T01:00:00+02:00"),
			);

			// Without capturedAt the server's local month is used.
			const now = await upload(
				base({ filename: "IMG_0003.JPG" }),
				bytesOf("now"),
			);
			expect((await json(now)).path).toBe(
				"Uploads/Eric's iPhone/2026/10/IMG_0003.JPG",
			);
		});

		test("hostile device names and filenames become single safe segments", async () => {
			const cases: Array<[Query, string]> = [
				[{ filename: "../x.jpg" }, "Uploads/Phone/2026/10/_x.jpg"],
				[{ filename: "..\\..\\y.jpg" }, "Uploads/Phone/2026/10/_.._y.jpg"],
				[{ filename: ".hidden.jpg" }, "Uploads/Phone/2026/10/hidden.jpg"],
				[
					{ filename: "a\u0000b\u0001c\u007f\n.jpg" },
					"Uploads/Phone/2026/10/abc.jpg",
				],
				[{ filename: "  spaced.jpg  " }, "Uploads/Phone/2026/10/spaced.jpg"],
				[{ filename: "Cafe\u0301.jpg" }, "Uploads/Phone/2026/10/Café.jpg"],
				[
					{ filename: `${"a".repeat(200)}.jpg` },
					`Uploads/Phone/2026/10/${"a".repeat(116)}.jpg`,
				],
				[
					{ filename: `${"é".repeat(100)}.jpg` },
					`Uploads/Phone/2026/10/${"é".repeat(58)}.jpg`,
				],
				[
					{ deviceName: "../../etc", filename: "d1.jpg" },
					"Uploads/_.._etc/2026/10/d1.jpg",
				],
				[
					{ deviceName: ".incoming", filename: "d2.jpg" },
					"Uploads/incoming/2026/10/d2.jpg",
				],
				[
					{ deviceName: "...", filename: "d3.jpg" },
					"Uploads/Device/2026/10/d3.jpg",
				],
				[
					{ deviceName: "a/b\\c", filename: "d4.jpg" },
					"Uploads/a_b_c/2026/10/d4.jpg",
				],
			];
			for (const [index, [overrides, expected]] of cases.entries()) {
				const response = await upload(
					base({ deviceName: "Phone", ...overrides }),
					bytesOf(`file-${index}`),
				);
				expect({ overrides, status: response.status }).toEqual({
					overrides,
					status: 201,
				});
				expect((await json(response)).path).toBe(expected);
				expect(existsSync(join(root, expected))).toBe(true);
			}
			for (const file of libraryFiles()) {
				expect(file.startsWith("Uploads/")).toBe(true);
				for (const segment of file.split("/")) {
					expect(segment.startsWith(".")).toBe(false);
					expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(120);
				}
			}
			expect(sanitizePathSegment("x".repeat(130))).toBe("x".repeat(120));
			// An over-long "extension" is part of the name, not kept whole.
			expect(sanitizePathSegment(`a.${"b".repeat(200)}`)).toBe(
				`a.${"b".repeat(118)}`,
			);
		});

		test("resources of one asset share the first resource's stem and folder", async () => {
			const asset = "ABC-123/L0/001";
			const photo = await upload(
				base({
					assetId: asset,
					resource: "photo",
					capturedAt: "2026-05-02T10:00:00+02:00",
				}),
				bytesOf("still"),
			);
			expect((await json(photo)).path).toBe(
				"Uploads/Eric's iPhone/2026/05/IMG_0001.HEIC",
			);
			// A different original name and capture month still pair with the still.
			const paired = await upload(
				base({
					filename: "FullSizeRender.mov",
					assetId: asset,
					resource: "pairedVideo",
					capturedAt: "2026-06-01T00:00:00Z",
				}),
				bytesOf("clip"),
			);
			expect((await json(paired)).path).toBe(
				"Uploads/Eric's iPhone/2026/05/IMG_0001.mov",
			);
			const alternate = await upload(
				base({
					filename: "IMG_E0001.JPG",
					assetId: asset,
					resource: "alternatePhoto",
				}),
				bytesOf("edited"),
			);
			expect((await json(alternate)).path).toBe(
				"Uploads/Eric's iPhone/2026/05/IMG_0001.JPG",
			);
			// The same asset id on another device is independent.
			const other = await upload(
				base({
					deviceId: OTHER_DEVICE,
					deviceName: "iPad",
					filename: "IMG_9.HEIC",
					assetId: asset,
					resource: "photo",
				}),
				bytesOf("ipad"),
			);
			expect((await json(other)).path).toBe("Uploads/iPad/2026/10/IMG_9.HEIC");
		});

		test("stem sharing survives a name collision on the first resource", async () => {
			const folder = join(root, "Uploads", "Eric's iPhone", "2026", "10");
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "IMG_0001.HEIC"), "someone else's file");
			const photo = await upload(
				base({ assetId: "live", resource: "photo" }),
				bytesOf("live still"),
			);
			expect((await json(photo)).path).toBe(
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (2).HEIC",
			);
			const video = await upload(
				base({
					filename: "IMG_0001.MOV",
					assetId: "live",
					resource: "pairedVideo",
				}),
				bytesOf("live clip"),
			);
			expect((await json(video)).path).toBe(
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (2).MOV",
			);
			expect(readFileSync(join(folder, "IMG_0001.HEIC"), "utf8")).toBe(
				"someone else's file",
			);
		});

		test("collisions get (2), (3), ... and never overwrite existing files", async () => {
			const folder = join(root, "Uploads", "Eric's iPhone", "2026", "10");
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "IMG_0001.HEIC"), "original");
			const paths: string[] = [];
			for (const content of ["second", "third", "fourth"]) {
				const response = await upload(base(), bytesOf(content));
				expect(response.status).toBe(201);
				paths.push((await json(response)).path as string);
			}
			expect(paths).toEqual([
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (2).HEIC",
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (3).HEIC",
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (4).HEIC",
			]);
			expect(readFileSync(join(folder, "IMG_0001.HEIC"), "utf8")).toBe(
				"original",
			);
			expect(readFileSync(join(root, paths[1]), "utf8")).toBe("third");
			// A recorded path whose file was deleted is never reused.
			rmSync(join(root, paths[0]));
			const again = await upload(base(), bytesOf("fifth"));
			expect((await json(again)).path).toBe(
				"Uploads/Eric's iPhone/2026/10/IMG_0001 (5).HEIC",
			);
			expect(incomingFiles()).toEqual([]);
		});

		test("a recorded asset key is a duplicate without reading or writing", async () => {
			const key = { assetId: "asset-1", resource: "photo" };
			const first = await upload(base(key), bytesOf("one"));
			expect(first.status).toBe(201);
			const firstPath = (await json(first)).path as string;

			const body = trackedBody(bytesOf("different bytes", 100));
			const again = await upload(
				base({ ...key, deviceId: DEVICE.toLowerCase(), filename: "other.jpg" }),
				body.stream,
				1500,
			);
			expect(again.status).toBe(200);
			expect(await json(again)).toEqual({
				status: "duplicate",
				path: firstPath,
				size: 3,
			});
			expect(body.state.pulls).toBe(0);
			expect(libraryFiles()).toEqual([firstPath]);
			expect(incomingFiles()).toEqual([]);
			expect(database.select().from(uploads).all()).toHaveLength(1);
			expect(notifyUploaded).toHaveBeenCalledTimes(1);
		});

		test("identical bytes are a duplicate: temp deleted and the asset key recorded", async () => {
			const bytes = bytesOf("same photo", 500);
			const first = await upload(base({ filename: "a.jpg" }), bytes);
			expect(first.status).toBe(201);
			const firstPath = (await json(first)).path as string;

			const second = await upload(
				base({
					deviceId: OTHER_DEVICE,
					deviceName: "iPad",
					filename: "b.jpg",
					assetId: "ipad-asset",
					resource: "photo",
				}),
				bytes,
			);
			expect(second.status).toBe(200);
			expect(await json(second)).toEqual({
				status: "duplicate",
				path: firstPath,
				size: bytes.byteLength,
			});
			expect(libraryFiles()).toEqual([firstPath]);
			expect(incomingFiles()).toEqual([]);
			expect(database.select().from(uploads).all()).toHaveLength(1);
			expect(database.select().from(uploadAssets).all()).toMatchObject([
				{
					deviceId: OTHER_DEVICE.toLowerCase(),
					assetId: "ipad-asset",
					resource: "photo",
				},
			]);
			const knownResponse = await known(OTHER_DEVICE, ["ipad-asset"]);
			expect(await json(knownResponse)).toEqual({
				assets: [{ assetId: "ipad-asset", resources: ["photo"] }],
			});
			// The recorded key now short-circuits before the body is read.
			const body = trackedBody(bytes);
			const third = await upload(
				base({
					deviceId: OTHER_DEVICE,
					filename: "b.jpg",
					assetId: "ipad-asset",
					resource: "photo",
				}),
				body.stream,
				bytes.byteLength,
			);
			expect(third.status).toBe(200);
			expect(body.state.pulls).toBe(0);
			expect(notifyUploaded).toHaveBeenCalledTimes(1);
		});

		test("concurrent identical uploads store exactly one file", async () => {
			const bytes = bytesOf("concurrent", 20_000);
			const responses = await Promise.all(
				Array.from({ length: 6 }, (_, index) => {
					const { stream } = trackedBody(bytes, 8192);
					return upload(
						base({ assetId: `asset-${index}`, resource: "photo" }),
						stream,
						bytes.byteLength,
					);
				}),
			);
			const statuses = responses.map((response) => response.status).sort();
			expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
			const bodies = await Promise.all(responses.map(json));
			const paths = new Set(bodies.map((body) => body.path));
			expect(paths.size).toBe(1);
			expect(libraryFiles()).toEqual([...paths] as string[]);
			expect(incomingFiles()).toEqual([]);
			expect(database.select().from(uploads).all()).toHaveLength(1);
			expect(database.select().from(uploadAssets).all()).toHaveLength(6);
			expect(notifyUploaded).toHaveBeenCalledTimes(1);

			// Same asset key, different bytes, concurrently: one wins the key.
			const racing = await Promise.all(
				["left", "right"].map((content) =>
					upload(
						base({ filename: "race.jpg", assetId: "race", resource: "photo" }),
						bytesOf(content, 5000),
					),
				),
			);
			expect(racing.map((response) => response.status).sort()).toEqual([
				200, 201,
			]);
			const racePaths = new Set(
				(await Promise.all(racing.map(json))).map((body) => body.path),
			);
			expect(racePaths.size).toBe(1);
			expect(libraryFiles().filter((file) => file.includes("race"))).toEqual([
				...racePaths,
			] as string[]);
			expect(incomingFiles()).toEqual([]);
		});

		test("truncated, oversized or aborted bodies are UPLOAD_INCOMPLETE with no file or row", async () => {
			const short = await upload(base(), bytesOf("x", 100), 200);
			expect(short.status).toBe(400);
			expect(await json(short)).toEqual({
				error: {
					code: "UPLOAD_INCOMPLETE",
					message: "The upload body did not match Content-Length",
				},
			});
			const { stream } = trackedBody(bytesOf("y", 300), 100);
			const long = await upload(base(), stream, 150);
			expect((await json(long)).error).toMatchObject({
				code: "UPLOAD_INCOMPLETE",
			});
			let sent = 0;
			const aborted = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent++ < 2) controller.enqueue(bytesOf("z", 64));
					else controller.error(new Error("client went away"));
				},
			});
			const abort = await upload(base(), aborted, 1000);
			expect(abort.status).toBe(400);
			expect((await json(abort)).error).toMatchObject({
				code: "UPLOAD_INCOMPLETE",
			});
			expect(libraryFiles()).toEqual([]);
			expect(incomingFiles()).toEqual([]);
			expect(database.select().from(uploads).all()).toEqual([]);
			expect(notifyUploaded).not.toHaveBeenCalled();
		});

		test("POST /known reports recorded resources per asset for the device", async () => {
			for (const [index, [assetId, resource, filename]] of [
				["live", "photo", "IMG_1.HEIC"],
				["live", "pairedVideo", "IMG_1.MOV"],
				["raw", "alternatePhoto", "IMG_2.DNG"],
				["raw", "photo", "IMG_2.JPG"],
			].entries()) {
				const response = await upload(
					base({ assetId, resource, filename }),
					bytesOf(`resource-${index}`),
				);
				expect(response.status).toBe(201);
			}
			const response = await known(DEVICE.toLowerCase(), [
				"raw",
				"missing",
				"live",
				"raw",
			]);
			expect(response.status).toBe(200);
			expect(await json(response)).toEqual({
				assets: [
					{ assetId: "raw", resources: ["photo", "alternatePhoto"] },
					{ assetId: "live", resources: ["photo", "pairedVideo"] },
				],
			});
			expect(await json(await known(OTHER_DEVICE, ["live"]))).toEqual({
				assets: [],
			});
			const invalid = [
				{ deviceId: DEVICE, assetIds: [] },
				{ deviceId: DEVICE, assetIds: Array.from({ length: 1001 }, String) },
				{ deviceId: "nope", assetIds: ["a"] },
				{ deviceId: DEVICE, assetIds: [""] },
				{ deviceId: DEVICE, assetIds: ["a"], extra: true },
			];
			for (const body of invalid) {
				const bad = await app.request("/api/v1/uploads/known", {
					method: "POST",
					body: JSON.stringify(body),
				});
				expect(bad.status).toBe(400);
			}
			const malformed = await app.request("/api/v1/uploads/known", {
				method: "POST",
				body: "{",
			});
			expect(malformed.status).toBe(400);
			const max = await known(
				DEVICE,
				Array.from({ length: 1000 }, (_, index) => `id-${index}`),
			);
			expect(max.status).toBe(200);
		});

		test("photos/uploaded is sent only for created uploads; dispatch failure keeps the file", async () => {
			await upload(base(), bytesOf("a"));
			await upload(base({ filename: "b.jpg" }), bytesOf("a"));
			await upload(base({ filename: "c.txt" }), bytesOf("c"));
			await upload(base(), bytesOf("d", 10), 20);
			expect(notifyUploaded).toHaveBeenCalledTimes(1);

			notifyUploaded.mockImplementation(async () => {
				throw new Error("inngest down");
			});
			const error = console.error;
			console.error = () => undefined;
			try {
				const response = await upload(
					base({ filename: "e.jpg" }),
					bytesOf("e"),
				);
				expect(response.status).toBe(201);
			} finally {
				console.error = error;
			}
			expect(libraryFiles()).toHaveLength(2);
		});

		test("startup cleanup removes .incoming entries older than 24 hours", async () => {
			expect(await cleanIncomingUploads(root)).toBe(0);
			const incoming = join(root, "Uploads", ".incoming");
			mkdirSync(incoming, { recursive: true });
			const now = Date.now();
			const stale = new Date(now - 25 * 60 * 60 * 1000);
			writeFileSync(join(incoming, "stale"), "x");
			utimesSync(join(incoming, "stale"), stale, stale);
			mkdirSync(join(incoming, "stale-dir"));
			utimesSync(join(incoming, "stale-dir"), stale, stale);
			writeFileSync(join(incoming, "fresh"), "y");
			expect(await cleanIncomingUploads(root, now)).toBe(2);
			expect(readdirSync(incoming)).toEqual(["fresh"]);
		});
	});
}

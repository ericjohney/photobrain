/** Opt-in Linux api-cuda integration check. Requires the external calibrated
 * fixtures documented in adobe-denoise-cuda.md; never points at a live API/DB.
 * Starts its own API on loopback with temporary SQLite/cache storage. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [appArg, assetsArg, reportArg] = process.argv.slice(2);
assert(
	appArg && assetsArg && reportArg,
	"usage: bun check_cuda_image.ts APP_ROOT ASSET_DIR REPORT.json",
);
assert.equal(process.platform, "linux");
assert.equal(process.env.DENOISE_BACKEND, "cuda");
assert.equal(process.env.NVIDIA_TF32_OVERRIDE, "0");
const app = resolve(appArg),
	assets = resolve(assetsArg),
	report = resolve(reportArg);
for (const name of [
	"DSCF0008.RAF",
	"12766.ARW",
	"face.jpg",
	"models/dn_bayer.pbdn",
	"models/dn_xtrans.pbdn",
	"models/xtrans_details.pbdn",
])
	assert(statSync(join(assets, name)).size > 0, `missing ${name}`);
const scratch = mkdtempSync("/tmp/photobrain-cuda-image-");
const cache = join(scratch, "denoise");
mkdirSync(cache);
const profiles = join(assets, "profiles/Adobe Standard");
const digest = (data: Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
const records: object[] = [];
const reference = {
	100: "9f8952dad734497a4294a0155a1c7b46b86b982b412b28c2eb3ba64134cb383f",
	50: "a69bda3ac2c46a343afb9e41f0644cdc963000f709eb5ca1f76b4dfa3c5c26ee",
	sony: "52c6d132bec41fc3ba4dc6c628404e34f4b0ea59eddf2a234ab60b8833e33183",
};
async function record(value: object) {
	records.push(value);
	console.log(JSON.stringify(value));
	await Bun.write(
		report,
		`${JSON.stringify({ passed: false, records }, null, 2)}\n`,
	);
}
const listener = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = listener.port;
assert(port);
await listener.stop(true);
const origin = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;
let database: Database | undefined;
const log = openSync(`${report}.api.log`, "w");
const env = {
	...process.env,
	HOST: "127.0.0.1",
	PORT: String(port),
	NODE_ENV: "test",
	RUN_DB_INIT: "true",
	DATABASE_URL: join(scratch, "test.db"),
	PHOTO_DIRECTORY: assets,
	THUMBNAILS_DIRECTORY: join(scratch, "thumbnails"),
	RAW_DEVELOP_ENGINE: "adobe",
	ADOBE_PROFILE_DIR: profiles,
	DENOISE_MODEL_DIR: join(assets, "models"),
	DENOISE_CACHE_DIR: cache,
	FASTEMBED_CACHE_DIR: join(assets, "fastembed"),
	FACE_MODEL_DIR: join(assets, "faces"),
	PHOTO_PROCESSING_THREADS: "2",
	INNGEST_DEV: "1",
	INNGEST_BASE_URL: "http://127.0.0.1:1",
	INNGEST_EVENT_KEY: "",
	INNGEST_SIGNING_KEY: "",
	UPLOADS_ENABLED: "false",
};
async function request(
	path: string,
	expected = 200,
	body?: unknown,
	method?: string,
) {
	const response = await fetch(origin + path, {
		method: method ?? (body === undefined ? "GET" : "POST"),
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(180_000),
	});
	assert.equal(
		response.status,
		expected,
		`${path}: ${response.status === expected ? "" : await response.text()}`,
	);
	return response;
}
async function stop() {
	if (!server) return;
	server.kill("SIGTERM");
	const force = setTimeout(() => server?.kill("SIGKILL"), 10_000);
	await server.exited;
	clearTimeout(force);
	server = undefined;
}
try {
	server = Bun.spawn([process.execPath, "run", "src/index.ts"], {
		cwd: join(app, "apps/api"),
		env,
		stdout: log,
		stderr: log,
	});
	const deadline = Date.now() + 60_000;
	while (true) {
		assert(
			server.exitCode === null,
			`API exited ${server.exitCode}; see ${report}.api.log`,
		);
		try {
			const r = await fetch(`${origin}/api/health`);
			if (r.ok) break;
		} catch {}
		assert(Date.now() < deadline, "API startup deadline");
		await Bun.sleep(250);
	}
	database = new Database(env.DATABASE_URL);
	const insert = database.prepare(
		"INSERT INTO photos (id,path,name,size,created_at,modified_at,is_raw) VALUES (?,?,?,?,?,?,1)",
	);
	for (const [id, name, model] of [
		[1, "DSCF0008.RAF", "X100VI"],
		[2, "12766.ARW", "ILCE-1M2"],
	] as const) {
		const s = statSync(join(assets, name));
		insert.run(
			id,
			name,
			name,
			s.size,
			Math.floor(s.mtimeMs / 1000),
			Math.floor(s.mtimeMs / 1000),
		);
		database
			.prepare("INSERT INTO photo_exif (photo_id,camera_model) VALUES (?,?)")
			.run(id, model);
	}
	assert.deepEqual(database.prepare("PRAGMA integrity_check").get(), {
		integrity_check: "ok",
	});
	const catalog = await (await request("/api/v1/photos")).json();
	assert.equal(catalog.photos.length, 2);
	for (const photo of catalog.photos)
		for (const key of [
			"sourceRoot",
			"sourceFingerprint",
			"thumbnailRoot",
			"thumbnailKey",
		])
			assert(!(key in photo));
	const edit = await (await request("/api/v1/photos/1/raw-edit")).json();
	assert.equal(edit.supportsDenoise, true);
	assert.equal(edit.revision, 0);
	await record({
		check: "api-startup",
		migrations: database
			.prepare("SELECT count(*) AS n FROM __drizzle_migrations")
			.get(),
		health: true,
		catalog: 2,
		denoiseCapability: true,
		sqliteIntegrity: "ok",
	});
	for (const amount of [100, 50] as const) {
		const start = performance.now();
		const base = "/api/v1/photos/1/denoise";
		const job = await (
			await request(base, 202, { amount, revision: 0 })
		).json();
		await request(base, 503, { amount, revision: 0 });
		let final = job;
		const deadline = Date.now() + 240_000;
		while (final.status === "processing") {
			assert(Date.now() < deadline, "denoise deadline");
			await Bun.sleep(250);
			final = await (await request(`${base}/${job.id}`)).json();
		}
		assert.equal(final.status, "complete", JSON.stringify(final));
		assert(
			final.completed === final.total && final.total > 1,
			"must perform fresh inference",
		);
		const result = await request(`${base}/${job.id}/preview`);
		assert.equal(result.headers.get("x-developed-engine"), "adobe");
		assert.equal(result.headers.get("x-denoise-amount"), String(amount));
		const bytes = Buffer.from(await result.arrayBuffer());
		assert.equal(bytes.subarray(0, 4).toString(), "PBSP");
		const hash = digest(bytes);
		assert.equal(
			hash,
			reference[amount],
			"packaged output differs from the validated Linux addon",
		);
		await record({
			check: "http-denoise",
			amount,
			seconds: (performance.now() - start) / 1000,
			tiles: final.total,
			bytes: bytes.length,
			sha256: hash,
		});
		const recipe = { ...edit.settings, version: 2, denoise: amount };
		const saved = await (
			await request(
				"/api/v1/photos/1/raw-edit",
				200,
				{ revision: 0, settings: recipe },
				"PUT",
			)
		).json();
		assert.equal(saved.revision, 1);
		const replay = await request("/api/photos/1/smart-preview");
		const replayBytes = new Uint8Array(await replay.arrayBuffer());
		assert.equal(digest(replayBytes), hash);
		const etag = replay.headers.get("etag");
		assert(etag);
		const conditional = await fetch(`${origin}/api/photos/1/smart-preview`, {
			headers: { "If-None-Match": etag },
		});
		assert.equal(conditional.status, 304);
		await request(base, 409, { amount, revision: 0 });
		// Reset only the harness's throwaway recipe for the next independently tested amount.
		database.prepare("DELETE FROM photo_raw_edits WHERE photo_id = 1").run();
		await record({
			check: "saved-recipe-replay",
			amount,
			exactPreview: true,
			conditional304: true,
			staleRevision409: true,
		});
	}
	const search = await (
		await request("/api/v1/search", 200, {
			query: "a landscape photograph",
			limit: 10,
		})
	).json();
	await record({
		check: "api-clip-text-search",
		responseKeys: Object.keys(search),
	});
	database.close();
	database = undefined;
	await stop();

	// The HTTP API has exited and released its CUDA contexts. All of the following
	// models now share one N-API/ORT process, including real YuNet/SFace execution.
	process.env.FASTEMBED_CACHE_DIR = env.FASTEMBED_CACHE_DIR;
	process.env.FACE_MODEL_DIR = env.FACE_MODEL_DIR;
	process.env.PHOTO_PROCESSING_THREADS = "2";
	const native = require(join(app, "packages/image-processing/dist/index.js"));
	function cpu() {
		const text = native.clipTextEmbedding("a portrait photograph");
		const image = native.batchGenerateClipEmbeddings([
			join(assets, "face.jpg"),
		])[0];
		for (const vector of [text, image])
			assert(vector && vector.length === 512 && vector.every(Number.isFinite));
		const detected = native.detectFaces([join(assets, "face.jpg")])[0];
		assert(
			detected.success && detected.faces.length > 0,
			"fixture must exercise SFace as well as YuNet",
		);
		for (const face of detected.faces) {
			assert(
				face.embedding.length === 128 && face.embedding.every(Number.isFinite),
			);
			assert(Math.abs(Math.hypot(...face.embedding) - 1) < 1e-5);
		}
		return { text, image, detected };
	}
	const before = cpu();
	await record({
		check: "cpu-models-before-cuda",
		textDimension: before.text.length,
		imageDimension: before.image.length,
		faces: before.detected.faces.length,
	});
	const options = {
		engine: "adobe",
		adobeProfileDir: profiles,
		denoiseModelDir: join(assets, "models"),
		denoiseCacheDir: cache,
		denoiseAmount: 100,
		denoiseProgress: new Int32Array(new SharedArrayBuffer(8)),
	};
	let hash = "";
	for (let i = 0; i < 2; i++) {
		native.clearDevelopedRawCache();
		const start = performance.now();
		const preview = native.prepareSmartPreview(
			join(assets, "12766.ARW"),
			0,
			undefined,
			options,
		);
		const actual = digest(preview.data);
		assert.equal(
			actual,
			reference.sony,
			"packaged Sony output differs from the validated Linux addon",
		);
		if (i) {
			assert.equal(actual, hash);
			assert.deepEqual(Array.from(options.denoiseProgress), [1, 1]);
		} else assert(options.denoiseProgress[1] > 1);
		hash = actual;
		await record({
			check: "native-sony-denoise",
			cached: !!i,
			sha256: hash,
			seconds: (performance.now() - start) / 1000,
			tiles: Array.from(options.denoiseProgress),
		});
	}
	assert.deepEqual(cpu(), before);
	const libraries = [
		...new Set(
			readFileSync("/proc/self/maps", "utf8")
				.split("\n")
				.map((line) => line.split(/\s+/).at(-1))
				.filter(
					(path) => path && /lib(onnxruntime|cudnn|cublas|cudart)/.test(path),
				),
		),
	];
	assert(
		libraries.some((path) =>
			path?.startsWith("/opt/onnxruntime/lib/libonnxruntime.so"),
		),
	);
	assert(
		libraries.some((path) =>
			path?.startsWith("/opt/onnxruntime/lib/libonnxruntime_providers_cuda.so"),
		),
	);
	await record({ check: "cpu-models-after-cuda", exact: true, libraries });
	await Bun.write(
		report,
		`${JSON.stringify({ passed: true, records }, null, 2)}\n`,
	);
} finally {
	database?.close();
	await stop();
	closeSync(log);
	rmSync(scratch, { recursive: true, force: true });
}

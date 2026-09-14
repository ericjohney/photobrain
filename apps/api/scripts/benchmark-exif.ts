import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const paths = process.argv.slice(2).map((path) => resolve(path));
if (
	!paths.length ||
	paths.length > 20 ||
	new Set(paths).size !== paths.length
) {
	throw new Error("Usage: bun run bench:exif <1-20 distinct photo paths>");
}
assert(
	paths.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 1, 0) <=
		32 * 1024,
	"Paths exceed the native single-command 32 KiB budget",
);
for (const path of paths) {
	if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`);
}

// Read the exact native flags so comparisons do not silently drift from production.
const source = await Bun.file(
	new URL("../../../packages/image-processing/src/exif.rs", import.meta.url),
).text();
const block = source.match(/const METADATA_ARGS: &\[&str\] = &\[([\s\S]*?)\];/);
assert(block, "Cannot locate native metadata arguments");
const args = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.equal(args.at(-1), "--");
const executable = process.env.EXIFTOOL_BIN || "exiftool";

type Record = { SourceFile: string; Error?: string; [tag: string]: unknown };
async function extract(files: string[]): Promise<Record[]> {
	const child = Bun.spawn([executable, ...args, ...files], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(status, 0, `ExifTool failed: ${stderr}`);
	const records = JSON.parse(stdout) as Record[];
	assert.equal(records.length, files.length, "Missing metadata records");
	for (const record of records) {
		assert(!record.Error, record.Error);
		assert(files.includes(record.SourceFile), "Unexpected SourceFile");
	}
	return records;
}

async function perFile() {
	let next = 0;
	const records: Record[] = [];
	await Promise.all(
		Array.from({ length: Math.min(4, paths.length) }, async () => {
			while (next < paths.length) {
				const path = paths[next++];
				records.push(...(await extract([path])));
			}
		}),
	);
	return records;
}

const normalize = (records: Record[]) =>
	records.sort((a, b) => a.SourceFile.localeCompare(b.SourceFile));
const baseline = normalize(await perFile());
assert.deepEqual(normalize(await extract(paths)), baseline);
const times = { batch: [] as number[], perFile: [] as number[] };
for (let round = 0; round < 5; round++) {
	const modes =
		round % 2
			? (["perFile", "batch"] as const)
			: (["batch", "perFile"] as const);
	for (const mode of modes) {
		const started = performance.now();
		const records = await (mode === "batch" ? extract(paths) : perFile());
		times[mode].push(performance.now() - started);
		assert.deepEqual(normalize(records), baseline);
	}
}
const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
	`EXIF only: ${paths.length} files, warm-up + five alternating rounds, identical JSON verified.`,
);
console.log(
	`Per file (up to 4 processes concurrently): ${median(times.perFile).toFixed(1)}ms median; ${paths.length} launches/round`,
);
console.log(
	`Batched: ${median(times.batch).toFixed(1)}ms median; 1 launch/round`,
);
console.log(
	`Metadata speedup: ${(median(times.perFile) / median(times.batch)).toFixed(2)}x`,
);
console.log(
	"No decoding, RAW previews, thumbnails, database writes, or CLIP are measured. Inputs are read-only; results depend on files, cache, and storage.",
);

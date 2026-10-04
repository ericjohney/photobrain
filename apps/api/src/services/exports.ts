import type { CollectionMember } from "./collections";
import { originalFilePath } from "./photo-files";
import { ZipWriter } from "./zip-writer";

export const EXPORT_SIZES = ["original", "2048", "1024"] as const;
export type ExportSize = (typeof EXPORT_SIZES)[number];
/** JPEG quality of rendered exports. */
export const EXPORT_JPEG_QUALITY = 90;
/** Renders/reads in flight or awaiting output at once while a ZIP streams. */
export const ZIP_LOOKAHEAD = 2;
export const EXPORT_ERRORS_NAME = "export-errors.txt";

/**
 * The native render exports need; the shared `NativeExecutor` satisfies it.
 * `run` rejects with `NativeExecutorBusyError` at the admission limit, while
 * `runWhenAdmitted` waits for capacity and withdraws on abort.
 */
export type ExportRenderer = {
	run(
		operation: "renderExportJpeg",
		path: string,
		maxEdge: number,
		quality: number,
	): Promise<Uint8Array<ArrayBuffer>>;
	runWhenAdmitted(
		signal: AbortSignal | undefined,
		operation: "renderExportJpeg",
		path: string,
		maxEdge: number,
		quality: number,
	): Promise<Uint8Array<ArrayBuffer>>;
};

/** `name` split at its last `.`; a leading dot alone (".profile") is no extension. */
function splitExtension(name: string): { stem: string; extension: string } {
	const dot = name.lastIndexOf(".");
	return dot > 0
		? { stem: name.slice(0, dot), extension: name.slice(dot) }
		: { stem: name, extension: "" };
}

/** The download filename: the original name, or `{stem}_{size}.jpg` when rendered. */
export function exportFilename(name: string, size: ExportSize): string {
	return size === "original"
		? name
		: `${splitExtension(name).stem}_${size}.jpg`;
}

/**
 * Hands out archive names, disambiguating case-insensitive repeats as
 * `stem (2).ext`, `stem (3).ext`, ... in the order names are claimed.
 */
export class UniqueNames {
	private readonly used = new Set<string>();

	claim(name: string): string {
		const { stem, extension } = splitExtension(name);
		let candidate = name;
		for (let copy = 2; this.used.has(candidate.toLowerCase()); copy++) {
			candidate = `${stem} (${copy})${extension}`;
		}
		this.used.add(candidate.toLowerCase());
		return candidate;
	}
}

type Loaded =
	| { ok: true; name: string; modifiedAt: Date; data: Uint8Array }
	| { ok: false; name: string; reason: string };

const SOURCE_MISSING_REASON = "source file missing";

function failureReason(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	)
		return SOURCE_MISSING_REASON;
	const message = error instanceof Error ? error.message : String(error);
	// One line per member in the error listing.
	return `export failed: ${message.replace(/\s+/g, " ").trim()}`;
}

/**
 * A STORE ZIP of `members` in order, one entry per member named by
 * `exportFilename`. Videos are never rendered: every size exports a video's
 * original file under its original name.
 * Originals are read whole and rendered sizes are rendered
 * on the native executor, waiting for admission rather than failing. Members
 * whose source is missing or fails are skipped and listed in a final
 * `export-errors.txt`. The stream is pull-based: at most `ZIP_LOOKAHEAD`
 * members are loading or awaiting output beyond the chunk being written, and
 * cancelling the stream (or aborting `signal`) withdraws queued renders, so
 * only an already-running render or file read outlives it.
 */
export function collectionZipStream(
	members: readonly CollectionMember[],
	options: {
		size: ExportSize;
		photoDirectory: string;
		renderer: ExportRenderer;
		signal?: AbortSignal;
	},
): ReadableStream<Uint8Array> {
	const { size, photoDirectory, renderer } = options;
	const abort = new AbortController();
	const stop = () => abort.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", stop, { once: true });
	const writer = new ZipWriter();
	const names = new UniqueNames();
	const loads: Promise<Loaded>[] = [];
	const chunks: Uint8Array[] = [];
	const failures: string[] = [];
	let next = 0;
	let finished = false;

	async function load(member: CollectionMember): Promise<Loaded> {
		const memberSize = member.mediaType === "video" ? "original" : size;
		const name = exportFilename(member.name, memberSize);
		const path = originalFilePath(member, photoDirectory);
		try {
			let data: Uint8Array;
			if (memberSize === "original") {
				data = await Bun.file(path).bytes();
			} else {
				if (!(await Bun.file(path).exists()))
					return { ok: false, name, reason: SOURCE_MISSING_REASON };
				data = await renderer.runWhenAdmitted(
					abort.signal,
					"renderExportJpeg",
					path,
					Number(memberSize),
					EXPORT_JPEG_QUALITY,
				);
			}
			return { ok: true, name, modifiedAt: member.modifiedAt, data };
		} catch (error) {
			return { ok: false, name, reason: failureReason(error) };
		}
	}

	function fill() {
		while (
			!abort.signal.aborted &&
			loads.length < ZIP_LOOKAHEAD &&
			next < members.length
		) {
			loads.push(load(members[next++]));
		}
	}

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				for (;;) {
					if (abort.signal.aborted) {
						// Settles a pending read instead of leaving it hanging.
						controller.error(abort.signal.reason);
						return;
					}
					const chunk = chunks.shift();
					if (chunk) {
						controller.enqueue(chunk);
						return;
					}
					if (finished) {
						options.signal?.removeEventListener("abort", stop);
						controller.close();
						return;
					}
					fill();
					const loading = loads.shift();
					if (!loading) {
						if (failures.length) {
							chunks.push(
								...writer.entry(
									names.claim(EXPORT_ERRORS_NAME),
									new TextEncoder().encode(`${failures.join("\n")}\n`),
									new Date(),
								),
							);
						}
						chunks.push(writer.finish());
						finished = true;
						continue;
					}
					const result = await loading;
					// Start the next member before this one's bytes are written.
					fill();
					if (result.ok) {
						chunks.push(
							...writer.entry(
								names.claim(result.name),
								result.data,
								result.modifiedAt,
							),
						);
					} else {
						failures.push(`${result.name}: ${result.reason}`);
					}
				}
			},
			cancel: stop,
		},
		// Pull only when the consumer reads: entries are large single chunks.
		{ highWaterMark: 0 },
	);
}

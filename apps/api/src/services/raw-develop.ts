import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export class RawDevelopError extends Error {
	constructor(
		message: string,
		public readonly status: 422 | 503 | 504,
	) {
		super(message);
	}
}

let active = false;

/** Full-quality, as-shot Display P3 JPEG, held only for this request. */
export async function developRaw(
	path: string,
	signal: AbortSignal,
): Promise<Buffer> {
	if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
	if (active)
		throw new RawDevelopError("RAW developer is busy. Try again shortly.", 503);
	active = true;
	try {
		const binary =
			process.env.RAW_DEVELOP_BIN ??
			fileURLToPath(
				new URL(
					"../../../../packages/raw-develop/target/release/raw-develop",
					import.meta.url,
				),
			);
		return await new Promise<Buffer>((resolve, reject) => {
			execFile(
				binary,
				["develop", path, "-"],
				{
					encoding: "buffer",
					signal,
					timeout: 120_000,
					maxBuffer: 80 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (!error) return resolve(stdout);
					if (error.name === "AbortError") return reject(error);
					console.error(
						"RAW development failed:",
						stderr.toString().slice(-4000) || error.message,
					);
					const code = (error as NodeJS.ErrnoException).code;
					reject(
						code === "ENOENT"
							? new RawDevelopError(
									"RAW developer is unavailable. Build packages/raw-develop or set RAW_DEVELOP_BIN.",
									503,
								)
							: error.killed
								? new RawDevelopError("RAW development timed out.", 504)
								: new RawDevelopError(
										"Could not develop this RAW. The camera or RAW format may be unsupported.",
										422,
									),
					);
				},
			);
		});
	} finally {
		active = false;
	}
}

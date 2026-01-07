import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { config } from "../config";

export interface RawConversionResult {
	success: boolean;
	outputPath?: string;
	error?: string;
	duration?: number;
}

let darktableAvailable: boolean | null = null;

/**
 * Check if darktable-cli is available on the system
 * Result is cached after first check
 */
export async function isDarktableAvailable(): Promise<boolean> {
	if (darktableAvailable !== null) {
		return darktableAvailable;
	}

	try {
		const proc = spawn([config.DARKTABLE_CLI_PATH, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		darktableAvailable = exitCode === 0;
	} catch {
		darktableAvailable = false;
	}

	if (!darktableAvailable) {
		console.warn("⚠️ darktable-cli not found. RAW files will not be processed.");
	}

	return darktableAvailable;
}

/**
 * Convert a RAW file to a temporary JPEG using darktable-cli
 * Returns the path to the temporary JPEG file
 *
 * Command: darktable-cli input.raw output.jpg --width 1600 --height 1600 --out-ext jpg --hq true
 */
export async function convertRawToTemp(
	inputPath: string,
): Promise<RawConversionResult> {
	const startTime = Date.now();

	// Check if darktable is available
	if (!(await isDarktableAvailable())) {
		return {
			success: false,
			error: "darktable-cli not found",
		};
	}

	// Create a temporary directory for the output
	const tempDir = await mkdtemp(join(tmpdir(), "photobrain-raw-"));
	const outputPath = join(tempDir, "converted.jpg");

	try {
		const proc = spawn(
			[
				config.DARKTABLE_CLI_PATH,
				inputPath,
				outputPath,
				"--width",
				"1600",
				"--height",
				"1600",
				"--out-ext",
				"jpg",
				"--hq",
				"true",
				"--apply-custom-presets",
				"true", // Enable default workflow (exposure +0.7 EV, sigmoid tone mapping, color calibration)
				"--icc-type",
				"SRGB", // Web-compatible color profile
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		// Set up timeout
		const timeoutId = setTimeout(() => {
			proc.kill();
		}, config.RAW_CONVERSION_TIMEOUT);

		const exitCode = await proc.exited;
		clearTimeout(timeoutId);

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			// Clean up temp directory on failure
			await rm(tempDir, { recursive: true, force: true });
			return {
				success: false,
				error: `darktable-cli exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
			};
		}

		return {
			success: true,
			outputPath,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		// Clean up temp directory on error
		await rm(tempDir, { recursive: true, force: true });
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Clean up a temporary conversion file and its directory
 */
export async function cleanupTempConversion(tempPath: string): Promise<void> {
	try {
		// The temp file is in a directory like /tmp/photobrain-raw-xxx/converted.jpg
		// Remove the parent directory
		const tempDir = join(tempPath, "..");
		await rm(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

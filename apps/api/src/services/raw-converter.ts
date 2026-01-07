import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "bun";
import { config } from "../config";

export interface RawConversionResult {
	success: boolean;
	outputPath?: string;
	error?: string;
	duration?: number;
}

export interface BatchConversionResult {
	success: boolean;
	/** Map of original RAW path → converted JPEG path */
	conversions: Map<string, string>;
	/** Files that failed to convert */
	failed: string[];
	duration: number;
	tempDir: string;
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

/**
 * Batch convert multiple RAW files using a single darktable-cli invocation
 * This amortizes the startup overhead across all files
 *
 * Command: darktable-cli --import file1.cr2 --import file2.nef ... /output/ --out-ext jpg
 */
export async function batchConvertRawFiles(
	inputPaths: string[],
): Promise<BatchConversionResult> {
	const startTime = Date.now();

	if (inputPaths.length === 0) {
		return {
			success: true,
			conversions: new Map(),
			failed: [],
			duration: 0,
			tempDir: "",
		};
	}

	// Check if darktable is available
	if (!(await isDarktableAvailable())) {
		return {
			success: false,
			conversions: new Map(),
			failed: inputPaths,
			duration: Date.now() - startTime,
			tempDir: "",
		};
	}

	// Create a temporary directory for all outputs
	const tempDir = await mkdtemp(join(tmpdir(), "photobrain-raw-batch-"));

	try {
		// Build command with --import for each file
		const args: string[] = [];
		for (const inputPath of inputPaths) {
			args.push("--import", inputPath);
		}
		args.push(
			tempDir,
			"--width",
			"1600",
			"--height",
			"1600",
			"--out-ext",
			"jpg",
			"--hq",
			"true",
			"--apply-custom-presets",
			"true",
			"--icc-type",
			"SRGB",
		);

		console.log(
			`🔄 Batch converting ${inputPaths.length} RAW files with single darktable-cli invocation...`,
		);

		const proc = spawn([config.DARKTABLE_CLI_PATH, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		// Longer timeout for batch processing
		const batchTimeout = config.RAW_CONVERSION_TIMEOUT * inputPaths.length;
		const timeoutId = setTimeout(() => {
			proc.kill();
		}, batchTimeout);

		const exitCode = await proc.exited;
		clearTimeout(timeoutId);

		const duration = Date.now() - startTime;
		const stderr = await new Response(proc.stderr).text();
		const stdout = await new Response(proc.stdout).text();

		console.log(`📊 Batch conversion exit code: ${exitCode}, duration: ${duration}ms`);

		// Map output files back to input files
		// darktable outputs files with same basename but .jpg extension
		// NOTE: darktable may exit with code 1 even if SOME files succeeded (e.g., one corrupt file)
		// So we check which files were actually created rather than relying on exit code
		let outputFiles: string[] = [];
		try {
			outputFiles = await readdir(tempDir);
		} catch {
			// tempDir doesn't exist or is empty
		}

		const conversions = new Map<string, string>();
		const failed: string[] = [];

		for (const inputPath of inputPaths) {
			const inputBasename = basename(inputPath).replace(/\.[^.]+$/, "");
			const expectedOutput = `${inputBasename}.jpg`;

			if (outputFiles.includes(expectedOutput)) {
				conversions.set(inputPath, join(tempDir, expectedOutput));
			} else {
				failed.push(inputPath);
			}
		}

		// If no files were converted at all, clean up and report failure
		if (conversions.size === 0) {
			console.error(`❌ Batch conversion failed completely (exit code ${exitCode})`);
			if (stderr) console.error(`stderr: ${stderr.slice(0, 500)}`);
			await rm(tempDir, { recursive: true, force: true });
			return {
				success: false,
				conversions: new Map(),
				failed: inputPaths,
				duration,
				tempDir: "",
			};
		}

		console.log(
			`✅ Batch conversion: ${conversions.size}/${inputPaths.length} succeeded in ${duration}ms (${failed.length} failed)`,
		);

		return {
			success: true,
			conversions,
			failed,
			duration,
			tempDir,
		};
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		return {
			success: false,
			conversions: new Map(),
			failed: inputPaths,
			duration: Date.now() - startTime,
			tempDir: "",
		};
	}
}

/**
 * Clean up the batch conversion temp directory
 */
export async function cleanupBatchConversion(tempDir: string): Promise<void> {
	if (tempDir) {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

import { z } from "zod";

const configSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.coerce.number().default(3000),
	DATABASE_URL: z.string().default("./photobrain.db"),
	PHOTO_DIRECTORY: z.string().default("../../temp-photos"),
	THUMBNAILS_DIRECTORY: z.string().default("./thumbnails"),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	RUN_DB_INIT: z
		.string()
		.default("false")
		.transform((val) => val === "true" || val === "1"),
	// RAW conversion settings
	DARKTABLE_CLI_PATH: z.string().default("darktable-cli"),
	RAW_CONVERSION_TIMEOUT: z.coerce.number().default(120000), // 2 minutes
});

function loadConfig() {
	const result = configSchema.safeParse(process.env);

	if (!result.success) {
		console.error("❌ Invalid environment variables:");
		console.error(result.error.format());
		throw new Error("Invalid environment configuration");
	}

	return result.data;
}

export const config = loadConfig();

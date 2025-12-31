import { z } from "zod";

const configSchema = z.object({
	PORT: z.coerce.number().default(3000),
	DATABASE_URL: z.string().default("./photobrain.db"),
	PHOTO_DIRECTORY: z.string().default("../../temp-photos"),
	THUMBNAIL_DIRECTORY: z.string().default("../../thumbnails"),
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
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

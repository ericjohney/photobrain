import { z } from "zod";

const configSchema = z.object({
	HOST: z.string().default("localhost"),
	PORT: z.coerce.number().default(3000),
	DATABASE_URL: z.string().default("./photobrain.db"),
	PHOTO_DIRECTORY: z.string().default("../../temp-photos"),
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	RUN_DB_INIT: z
		.string()
		.transform((val) => val === "true" || val === "1")
		.default("false"),
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

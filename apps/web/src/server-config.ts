import { z } from "zod";

const configSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.coerce.number().default(3001),
	API_URL: z.string().default("http://localhost:3000"),
	// Unset leaves the client's VITE_MAP_STYLE_URL/default style in effect.
	MAP_STYLE_URL: z.string().url().optional(),
});

function loadConfig() {
	const result = configSchema.safeParse({
		...process.env,
		// Map VITE_API_URL to API_URL for backwards compatibility
		API_URL: process.env.VITE_API_URL || process.env.API_URL,
		MAP_STYLE_URL: process.env.MAP_STYLE_URL || undefined,
	});

	if (!result.success) {
		console.error("❌ Invalid environment variables:");
		console.error(result.error.format());
		throw new Error("Invalid environment configuration");
	}

	return result.data;
}

export const serverConfig = loadConfig();

// Client config that gets injected into the HTML at runtime
export const clientConfig = {
	apiUrl: serverConfig.API_URL,
	...(serverConfig.MAP_STYLE_URL && {
		MAP_STYLE_URL: serverConfig.MAP_STYLE_URL,
	}),
};

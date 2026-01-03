import { z } from "zod";

const configSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.coerce.number().default(3001),
	API_URL: z.string().default("http://localhost:3000"),
});

function loadConfig() {
	const result = configSchema.safeParse({
		...process.env,
		// Map VITE_API_URL to API_URL for backwards compatibility
		API_URL: process.env.VITE_API_URL || process.env.API_URL,
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
};

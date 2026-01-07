import Constants from "expo-constants";
import { z } from "zod";

const configSchema = z.object({
	API_URL: z.string().url().default("http://localhost:3000"),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
});

function loadConfig() {
	// Expo environment variables
	const env = {
		API_URL:
			Constants.expoConfig?.extra?.apiUrl || process.env.EXPO_PUBLIC_API_URL,
		NODE_ENV: process.env.NODE_ENV,
	};

	const result = configSchema.safeParse(env);

	if (!result.success) {
		console.error("❌ Invalid environment variables:");
		console.error(result.error.format());
		throw new Error("Invalid environment configuration");
	}

	return result.data;
}

export const config = loadConfig();

// For backwards compatibility
export const API_URL = config.API_URL;

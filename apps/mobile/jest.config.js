module.exports = {
	preset: "jest-expo",
	setupFiles: ["<rootDir>/__tests__/globalSetup.js"],
	setupFilesAfterEnv: ["<rootDir>/__tests__/setup.ts"],
	// React's async act/cleanup uses immediates; faking them deadlocks on Node 22.
	fakeTimers: { doNotFake: ["setImmediate", "clearImmediate"] },
	transformIgnorePatterns: [
		"node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@trpc/.*|superjson|@tanstack/.*|react-native-reanimated|react-native-gesture-handler)",
	],
	moduleNameMapper: {
		"^@/(.*)$": "<rootDir>/src/$1",
	},
	testMatch: ["<rootDir>/__tests__/**/*.test.{ts,tsx}"],
	testTimeout: 15_000,
};

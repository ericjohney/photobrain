// Provide globals that expo's runtime.native.ts lazily installs.
// Without these, the lazy require() calls fail with "outside of the scope" errors.

if (typeof globalThis.__ExpoImportMetaRegistry === "undefined") {
	globalThis.__ExpoImportMetaRegistry = { get url() { return null; } };
}

if (typeof globalThis.structuredClone === "undefined") {
	globalThis.structuredClone = (val) => JSON.parse(JSON.stringify(val));
}

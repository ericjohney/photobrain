import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { PhotoBrainMigrationBridgeModule } from "../../modules/migration-bridge";

export const THEME_STORAGE_KEY = "@photobrain/theme";
export const ACTIVE_SCAN_STORAGE_KEY = "@photobrain/active-scan";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MigrationTheme = "system" | "light" | "dark";

export interface MigrationEnvelope {
	schemaVersion: 1;
	theme: MigrationTheme;
	activeScanId: string | null;
}

export type MigrationEnvelopeReadResult =
	| { status: "absent" }
	| { status: "invalid" }
	| { status: "valid"; envelope: MigrationEnvelope };

type NativeMigrationBridge = PhotoBrainMigrationBridgeModule;

interface NativeMigrationBridgePackage {
	default: NativeMigrationBridge;
}

let nativeModule: NativeMigrationBridge | undefined;
let initializationPromise: Promise<MigrationEnvelopeReadResult> | undefined;

function isTheme(value: unknown): value is MigrationTheme {
	return value === "system" || value === "light" || value === "dark";
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

function parseNativeReadResult(value: unknown): MigrationEnvelopeReadResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { status: "invalid" };
	}

	const candidate = value as Record<string, unknown>;
	if (
		(candidate.status === "absent" || candidate.status === "invalid") &&
		hasExactKeys(candidate, ["status"])
	) {
		return { status: candidate.status };
	}
	if (
		candidate.status !== "valid" ||
		!hasExactKeys(candidate, ["status", "envelope"]) ||
		!candidate.envelope ||
		typeof candidate.envelope !== "object" ||
		Array.isArray(candidate.envelope)
	) {
		return { status: "invalid" };
	}

	const envelope = candidate.envelope as Record<string, unknown>;
	if (
		!hasExactKeys(envelope, ["schemaVersion", "theme", "activeScanId"]) ||
		envelope.schemaVersion !== 1 ||
		!isTheme(envelope.theme) ||
		!(envelope.activeScanId === null || isUuid(envelope.activeScanId))
	) {
		return { status: "invalid" };
	}

	return {
		status: "valid",
		envelope: {
			schemaVersion: 1,
			theme: envelope.theme,
			activeScanId: envelope.activeScanId,
		},
	};
}

function getNativeModule(): NativeMigrationBridge {
	if (!nativeModule) {
		const migrationModulePackage: NativeMigrationBridgePackage = require("../../modules/migration-bridge");
		nativeModule = migrationModulePackage.default;
	}
	return nativeModule;
}

async function readNativeEnvelope(): Promise<MigrationEnvelopeReadResult> {
	try {
		return parseNativeReadResult(await getNativeModule().readEnvelope());
	} catch {
		return { status: "invalid" };
	}
}

async function initializeNativeEnvelope(): Promise<MigrationEnvelopeReadResult> {
	const [legacyTheme, legacyActiveScanId] = await Promise.all([
		AsyncStorage.getItem(THEME_STORAGE_KEY),
		AsyncStorage.getItem(ACTIVE_SCAN_STORAGE_KEY),
	]);
	const theme = isTheme(legacyTheme) ? legacyTheme : "system";
	const activeScanId = isUuid(legacyActiveScanId) ? legacyActiveScanId : null;
	const initialized = await getNativeModule().initializeEnvelope(
		theme,
		activeScanId,
	);
	if (!initialized) {
		return readNativeEnvelope();
	}
	return {
		status: "valid",
		envelope: { schemaVersion: 1, theme, activeScanId },
	};
}

async function readInitializedNativeEnvelope(): Promise<MigrationEnvelopeReadResult> {
	const stored = await readNativeEnvelope();
	if (stored.status !== "absent") {
		return stored;
	}
	if (initializationPromise) {
		return initializationPromise;
	}

	const pendingInitialization = initializeNativeEnvelope();
	initializationPromise = pendingInitialization;
	try {
		return await pendingInitialization;
	} finally {
		if (initializationPromise === pendingInitialization) {
			initializationPromise = undefined;
		}
	}
}

async function prepareNativeEnvelopeForUpdate(): Promise<void> {
	const stored = await readInitializedNativeEnvelope();
	if (stored.status !== "valid") {
		throw new Error("The iOS migration envelope is not writable.");
	}
}

async function updateNativeField(
	update: () => Promise<boolean>,
): Promise<void> {
	if (!(await update())) {
		throw new Error("The iOS migration envelope could not be updated.");
	}
}

export async function readMigrationEnvelope(): Promise<MigrationEnvelopeReadResult> {
	if (Platform.OS === "ios") {
		return readNativeEnvelope();
	}

	const [themeValue, activeScanId] = await Promise.all([
		AsyncStorage.getItem(THEME_STORAGE_KEY),
		AsyncStorage.getItem(ACTIVE_SCAN_STORAGE_KEY),
	]);
	if (themeValue === null && activeScanId === null) {
		return { status: "absent" };
	}
	if (
		(themeValue !== null && !isTheme(themeValue)) ||
		(activeScanId !== null && !isUuid(activeScanId))
	) {
		return { status: "invalid" };
	}
	return {
		status: "valid",
		envelope: {
			schemaVersion: 1,
			theme: themeValue ?? "system",
			activeScanId,
		},
	};
}

export async function getThemePreference(): Promise<MigrationTheme | null> {
	if (Platform.OS !== "ios") {
		const value = await AsyncStorage.getItem(THEME_STORAGE_KEY);
		return isTheme(value) ? value : null;
	}

	const stored = await readInitializedNativeEnvelope();
	return stored.status === "valid" ? stored.envelope.theme : null;
}

export async function setThemePreference(theme: MigrationTheme): Promise<void> {
	if (Platform.OS !== "ios") {
		await AsyncStorage.setItem(THEME_STORAGE_KEY, theme);
		return;
	}
	await prepareNativeEnvelopeForUpdate();
	await updateNativeField(() => getNativeModule().setTheme(theme));
}

export async function getActiveScanId(): Promise<string | null> {
	if (Platform.OS !== "ios") {
		return AsyncStorage.getItem(ACTIVE_SCAN_STORAGE_KEY);
	}

	const stored = await readInitializedNativeEnvelope();
	return stored.status === "valid" ? stored.envelope.activeScanId : null;
}

export async function setActiveScanId(
	activeScanId: string | null,
): Promise<void> {
	if (Platform.OS !== "ios") {
		if (activeScanId === null) {
			await AsyncStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
		} else {
			await AsyncStorage.setItem(ACTIVE_SCAN_STORAGE_KEY, activeScanId);
		}
		return;
	}
	await prepareNativeEnvelopeForUpdate();
	await updateNativeField(() =>
		getNativeModule().setActiveScanId(activeScanId),
	);
}

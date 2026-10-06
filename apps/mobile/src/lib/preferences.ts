import AsyncStorage from "@react-native-async-storage/async-storage";

export const THEME_STORAGE_KEY = "@photobrain/theme";
export const ACTIVE_SCAN_STORAGE_KEY = "@photobrain/active-scan";

export type ThemePreference = "system" | "light" | "dark";

function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export async function getThemePreference(): Promise<ThemePreference | null> {
	const value = await AsyncStorage.getItem(THEME_STORAGE_KEY);
	return isThemePreference(value) ? value : null;
}

export async function setThemePreference(
	theme: ThemePreference,
): Promise<void> {
	await AsyncStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function getActiveScanId(): Promise<string | null> {
	return AsyncStorage.getItem(ACTIVE_SCAN_STORAGE_KEY);
}

export async function setActiveScanId(
	activeScanId: string | null,
): Promise<void> {
	if (activeScanId === null) {
		await AsyncStorage.removeItem(ACTIVE_SCAN_STORAGE_KEY);
	} else {
		await AsyncStorage.setItem(ACTIVE_SCAN_STORAGE_KEY, activeScanId);
	}
}

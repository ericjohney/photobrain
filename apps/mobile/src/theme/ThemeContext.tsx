import AsyncStorage from "@react-native-async-storage/async-storage";
import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { useColorScheme } from "react-native";
import { type ColorTheme, colors, type ThemeColors } from "./colors";

const THEME_STORAGE_KEY = "@photobrain/theme";

type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
	theme: ColorTheme;
	themePreference: ThemePreference;
	colors: ThemeColors;
	setThemePreference: (preference: ThemePreference) => void;
	toggleTheme: () => void;
	isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
	children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
	const systemColorScheme = useColorScheme();
	const [themePreference, setThemePreferenceState] =
		useState<ThemePreference>("system");
	const [isLoaded, setIsLoaded] = useState(false);

	// Determine actual theme based on preference and system setting
	const theme: ColorTheme =
		themePreference === "system"
			? systemColorScheme === "dark"
				? "dark"
				: "light"
			: themePreference;

	const isDark = theme === "dark";
	const themeColors = colors[theme];

	// Load saved preference on mount
	useEffect(() => {
		AsyncStorage.getItem(THEME_STORAGE_KEY)
			.then((value) => {
				if (value === "light" || value === "dark" || value === "system") {
					setThemePreferenceState(value);
				}
			})
			.catch(() => {
				// Ignore errors, use default
			})
			.finally(() => {
				setIsLoaded(true);
			});
	}, []);

	const setThemePreference = useCallback((preference: ThemePreference) => {
		setThemePreferenceState(preference);
		AsyncStorage.setItem(THEME_STORAGE_KEY, preference).catch(() => {
			// Ignore save errors
		});
	}, []);

	const toggleTheme = useCallback(() => {
		setThemePreference(isDark ? "light" : "dark");
	}, [isDark, setThemePreference]);

	// Don't render until we've loaded the preference to avoid flash
	if (!isLoaded) {
		return null;
	}

	return (
		<ThemeContext.Provider
			value={{
				theme,
				themePreference,
				colors: themeColors,
				setThemePreference,
				toggleTheme,
				isDark,
			}}
		>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}

// Hook for quick access to colors only
export function useColors(): ThemeColors {
	return useTheme().colors;
}

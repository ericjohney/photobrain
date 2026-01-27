/**
 * PhotoBrain color system - matches web app's Lightroom-inspired palette
 * Converted from HSL CSS variables to RGB hex values
 */

export const colors = {
	light: {
		// Core colors
		background: "#f5f5f5", // hsl(0 0% 96%)
		foreground: "#262626", // hsl(0 0% 15%)
		card: "#ffffff",
		cardForeground: "#262626",

		// Primary (blue accent)
		primary: "#0066cc", // hsl(210 100% 45%)
		primaryForeground: "#ffffff",

		// Secondary
		secondary: "#ebebeb", // hsl(0 0% 92%)
		secondaryForeground: "#333333",

		// Muted
		muted: "#f0f0f0", // hsl(0 0% 94%)
		mutedForeground: "#737373", // hsl(0 0% 45%)

		// Accent
		accent: "#e6e6e6", // hsl(0 0% 90%)
		accentForeground: "#262626",

		// Destructive
		destructive: "#ef4444", // hsl(0 84% 60%)
		destructiveForeground: "#ffffff",

		// Border/Input
		border: "#e0e0e0", // hsl(0 0% 88%)
		input: "#ffffff",

		// Panel system (Lightroom-specific)
		panel: "#f7f7f7", // hsl(0 0% 97%)
		panelForeground: "#404040",
		toolbar: "#f2f2f2", // hsl(0 0% 95%)
		filmstrip: "#ebebeb", // hsl(0 0% 92%)

		// Selection
		selection: "#0066cc", // hsl(210 100% 45%)
		selectionMuted: "#cce5ff", // hsl(210 100% 90%)

		// Thumbnail
		thumbnailBorder: "#d9d9d9", // hsl(0 0% 85%)

		// Status colors
		success: "#22c55e",
		warning: "#f59e0b",
		error: "#ef4444",
		info: "#3b82f6",
	},

	dark: {
		// Core colors - Lightroom-inspired dark palette
		background: "#1c1c1c", // hsl(0 0% 11%)
		foreground: "#d9d9d9", // hsl(0 0% 85%)
		card: "#262626", // hsl(0 0% 15%)
		cardForeground: "#d9d9d9",

		// Primary (blue accent)
		primary: "#0080ff", // hsl(210 100% 50%)
		primaryForeground: "#ffffff",

		// Secondary
		secondary: "#383838", // hsl(0 0% 22%)
		secondaryForeground: "#bfbfbf",

		// Muted
		muted: "#2e2e2e", // hsl(0 0% 18%)
		mutedForeground: "#8c8c8c", // hsl(0 0% 55%)

		// Accent
		accent: "#404040", // hsl(0 0% 25%)
		accentForeground: "#e6e6e6",

		// Destructive
		destructive: "#b33939", // hsl(0 70% 45%)
		destructiveForeground: "#ffffff",

		// Border/Input
		border: "#333333", // hsl(0 0% 20%)
		input: "#212121", // hsl(0 0% 13%)

		// Panel system (Lightroom-specific)
		panel: "#242424", // hsl(0 0% 14%)
		panelForeground: "#bfbfbf",
		toolbar: "#292929", // hsl(0 0% 16%)
		filmstrip: "#1f1f1f", // hsl(0 0% 12%)

		// Selection
		selection: "#0080ff", // hsl(210 100% 50%)
		selectionMuted: "#003366", // hsl(210 100% 25%)

		// Thumbnail
		thumbnailBorder: "#404040", // hsl(0 0% 25%)

		// Status colors
		success: "#22c55e",
		warning: "#f59e0b",
		error: "#ef4444",
		info: "#3b82f6",
	},
} as const;

export type ColorTheme = keyof typeof colors;
export type ThemeColors = (typeof colors)[ColorTheme];

/** PhotoBrain's iOS-aligned semantic palette. */

export const colors = {
	light: {
		background: "#ffffff",
		foreground: "#000000",
		card: "#f2f2f7",
		cardForeground: "#000000",

		// Primary (blue accent)
		primary: "#0066cc",
		primaryForeground: "#ffffff",

		// Secondary
		secondary: "#e5e5ea",
		secondaryForeground: "#1c1c1e",

		// Muted
		muted: "#f2f2f7",
		mutedForeground: "#6c6c70",

		// Accent
		accent: "#e5e5ea",
		accentForeground: "#000000",

		// Destructive
		destructive: "#c9342b",
		destructiveForeground: "#ffffff",
		destructiveMuted: "#fff0ef",

		// Border/Input
		border: "#c6c6c8",
		input: "#ffffff",

		// Panel system (Lightroom-specific)
		panel: "#f2f2f7",
		panelForeground: "#1c1c1e",
		toolbar: "#f9f9fb",
		filmstrip: "#e5e5ea",

		// Selection
		selection: "#007aff",
		selectionMuted: "#d9ecff",

		// Thumbnail
		thumbnailBorder: "#d1d1d6",

		// Status colors
		success: "#34c759",
		warning: "#ff9500",
		error: "#ff3b30",
		info: "#007aff",
	},

	dark: {
		background: "#000000",
		foreground: "#ffffff",
		card: "#1c1c1e",
		cardForeground: "#ffffff",

		// Primary (blue accent)
		primary: "#0a84ff",
		primaryForeground: "#000000",

		// Secondary
		secondary: "#2c2c2e",
		secondaryForeground: "#f2f2f7",

		// Muted
		muted: "#1c1c1e",
		mutedForeground: "#98989d",

		// Accent
		accent: "#2c2c2e",
		accentForeground: "#ffffff",

		// Destructive
		destructive: "#ff453a",
		destructiveForeground: "#ffffff",
		destructiveMuted: "#3a1513",

		// Border/Input
		border: "#38383a",
		input: "#1c1c1e",

		// Panel system (Lightroom-specific)
		panel: "#1c1c1e",
		panelForeground: "#f2f2f7",
		toolbar: "#1c1c1e",
		filmstrip: "#1c1c1e",

		// Selection
		selection: "#0a84ff",
		selectionMuted: "#003b73",

		// Thumbnail
		thumbnailBorder: "#38383a",

		// Status colors
		success: "#30d158",
		warning: "#ff9f0a",
		error: "#ff453a",
		info: "#0a84ff",
	},
} as const;

export type ColorTheme = keyof typeof colors;
export type ThemeColors = (typeof colors)[ColorTheme];

import type { Config } from "tailwindcss";

/** A design token from src/index.css, with Tailwind opacity modifiers (`bg-panel/80`). */
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

const config: Config = {
	darkMode: ["class"],
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			fontFamily: {
				sans: [
					"Inter",
					"-apple-system",
					"BlinkMacSystemFont",
					"Segoe UI",
					"Roboto",
					"sans-serif",
				],
			},
			fontSize: {
				"2xs": ["0.6875rem", { lineHeight: "1rem" }],
			},
			colors: {
				background: token("background"),
				foreground: token("foreground"),
				card: {
					DEFAULT: token("card"),
					foreground: token("card-foreground"),
				},
				popover: {
					DEFAULT: token("popover"),
					foreground: token("popover-foreground"),
				},
				primary: {
					DEFAULT: token("primary"),
					foreground: token("primary-foreground"),
				},
				secondary: {
					DEFAULT: token("secondary"),
					foreground: token("secondary-foreground"),
				},
				muted: {
					DEFAULT: token("muted"),
					foreground: token("muted-foreground"),
				},
				subtle: token("subtle"),
				accent: {
					DEFAULT: token("accent"),
					foreground: token("accent-foreground"),
				},
				destructive: {
					DEFAULT: token("destructive"),
					foreground: token("destructive-foreground"),
				},
				border: token("border"),
				input: token("input"),
				ring: token("ring"),
				panel: {
					DEFAULT: token("panel"),
					foreground: token("panel-foreground"),
				},
				well: token("well"),
				selection: token("selection"),
				star: token("star"),
				pick: {
					DEFAULT: token("pick"),
					foreground: token("pick-foreground"),
				},
				reject: {
					DEFAULT: token("reject"),
					foreground: token("reject-foreground"),
				},
				raw: {
					DEFAULT: token("raw"),
					foreground: token("raw-foreground"),
				},
				success: token("success"),
				warning: token("warning"),
				chart: {
					1: token("chart-1"),
					2: token("chart-2"),
					3: token("chart-3"),
					4: token("chart-4"),
					5: token("chart-5"),
				},
				overlay: {
					DEFAULT: token("overlay"),
					foreground: token("overlay-foreground"),
				},
			},
			borderRadius: {
				xl: "calc(var(--radius) + 4px)",
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};

export default config;

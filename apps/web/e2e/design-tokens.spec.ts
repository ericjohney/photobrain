import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Design-system guard: every color in src/ must come from the tokens in
 * src/index.css (exposed through tailwind.config.ts), so the warm-neutral
 * theme and light/dark mode apply everywhere.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Tailwind's built-in palettes and bare black/white, e.g. `bg-blue-500`, `text-white/80`. */
const PALETTE_CLASS =
	/\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|shadow|divide|accent|decoration|placeholder|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b|\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|decoration|placeholder|caret)-(?:black|white)\b/;

/** Literal colors in component code (index.css is the single place they belong). */
const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(tsx?|css)$/.test(name) && !name.endsWith("index.css")
			? [path]
			: [];
	});
}

test("components use design tokens, not raw palette colors", () => {
	const violations: string[] = [];
	for (const file of sourceFiles(SRC)) {
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (PALETTE_CLASS.test(line) || LITERAL_COLOR.test(line)) {
					violations.push(
						`${relative(SRC, file)}:${index + 1}: ${line.trim()}`,
					);
				}
			});
	}
	expect(
		violations,
		"Use semantic tokens (bg-panel, text-subtle, text-pick, bg-overlay/60, …) from src/index.css",
	).toEqual([]);
});

/**
 * Reusable widgets live in src/components/ui/. Their building-block styling
 * must not be re-implemented inline elsewhere.
 */
const UI_ONLY = [
	{ pattern: /role="radiogroup"/, use: "SegmentedControl or StarRating" },
	{ pattern: /\bbg-popover\b/, use: "Popover" },
	{ pattern: /\bbg-raw\b/, use: "RawBadge / Badge" },
];

test("shared widgets are used from components/ui, not re-implemented", () => {
	const uiDir = join(SRC, "components", "ui");
	const violations: string[] = [];
	for (const file of sourceFiles(SRC)) {
		if (file.startsWith(uiDir)) continue;
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, index) => {
				for (const { pattern, use } of UI_ONLY) {
					if (pattern.test(line)) {
						violations.push(
							`${relative(SRC, file)}:${index + 1}: use ${use}: ${line.trim()}`,
						);
					}
				}
			});
	}
	expect(violations).toEqual([]);
});

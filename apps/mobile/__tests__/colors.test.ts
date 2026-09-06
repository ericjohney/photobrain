import { colors } from "@/theme/colors";

function luminance(hex: string) {
	const channels = [1, 3, 5].map((offset) => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string) {
	const values = [luminance(a), luminance(b)];
	return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

it.each(["light", "dark"] as const)("keeps %s actions readable", (theme) => {
	const palette = colors[theme];
	expect(
		contrast(palette.primary, palette.primaryForeground),
	).toBeGreaterThanOrEqual(4.5);
	expect(contrast(palette.primary, palette.toolbar)).toBeGreaterThanOrEqual(
		4.5,
	);
	expect(
		contrast(palette.destructive, palette.background),
	).toBeGreaterThanOrEqual(4.5);
});

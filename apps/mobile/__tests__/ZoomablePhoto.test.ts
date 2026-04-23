/**
 * Unit tests for ZoomablePhoto clamping logic.
 *
 * These test the pure math functions extracted from the component.
 * Gesture interactions (pinch, pan, double-tap) can't be tested
 * in jest-expo — those are manual QA.
 */

// Import the pure functions from the component
import { clampScale, clampTranslation } from "@/components/ZoomablePhoto";

describe("ZoomablePhoto clamping", () => {
	describe("clampScale", () => {
		it("returns 1 when scale is below minimum", () => {
			expect(clampScale(0.5)).toBe(1);
			expect(clampScale(0)).toBe(1);
			expect(clampScale(-1)).toBe(1);
		});

		it("returns 5 when scale exceeds maximum", () => {
			expect(clampScale(6)).toBe(5);
			expect(clampScale(10)).toBe(5);
		});

		it("returns the input when within range", () => {
			expect(clampScale(1)).toBe(1);
			expect(clampScale(2.5)).toBe(2.5);
			expect(clampScale(5)).toBe(5);
		});
	});

	describe("clampTranslation", () => {
		const SCREEN = 750; // test screen dimension

		it("returns 0 when scale is 1 (fit to screen, no panning)", () => {
			expect(clampTranslation(100, SCREEN, 1)).toBe(0);
			expect(clampTranslation(-100, SCREEN, 1)).toBe(0);
		});

		it("returns 0 when scale is below 1", () => {
			expect(clampTranslation(50, SCREEN, 0.5)).toBe(0);
		});

		it("clamps translation to image bounds when zoomed", () => {
			// At 2x on 750px screen: maxTranslate = (750 * (2-1)) / 2 = 375
			expect(clampTranslation(500, SCREEN, 2)).toBe(375);
			expect(clampTranslation(-500, SCREEN, 2)).toBe(-375);
		});

		it("allows full range within bounds", () => {
			// At 2x: max is 375. Translate 200 should pass through.
			expect(clampTranslation(200, SCREEN, 2)).toBe(200);
			expect(clampTranslation(-200, SCREEN, 2)).toBe(-200);
		});

		it("allows more translation at higher zoom levels", () => {
			// At 3x: maxTranslate = (750 * (3-1)) / 2 = 750
			expect(clampTranslation(700, SCREEN, 3)).toBe(700);
			// At 5x: maxTranslate = (750 * (5-1)) / 2 = 1500
			expect(clampTranslation(1400, SCREEN, 5)).toBe(1400);
		});
	});
});

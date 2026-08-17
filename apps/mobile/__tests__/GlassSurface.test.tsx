import { act, waitFor } from "@testing-library/react-native";
import {
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import { AccessibilityInfo, Platform, Text } from "react-native";
import GlassSurface from "@/components/GlassSurface";
import { renderWithProviders } from "./test-utils";

const mockGlassApiAvailable = jest.mocked(isGlassEffectAPIAvailable);
const mockLiquidGlassAvailable = jest.mocked(isLiquidGlassAvailable);

describe("GlassSurface", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGlassApiAvailable.mockReturnValue(true);
		mockLiquidGlassAvailable.mockReturnValue(true);
		jest
			.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled")
			.mockResolvedValue(false);
		jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({
			remove: jest.fn(),
		} as ReturnType<typeof AccessibilityInfo.addEventListener>);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("uses native Liquid Glass when the platform APIs are available", async () => {
		const { getByTestId } = renderWithProviders(
			<GlassSurface>
				<Text>Glass content</Text>
			</GlassSurface>,
		);

		await waitFor(() => expect(getByTestId("native-glass")).toBeTruthy());
	});

	it("falls back when Liquid Glass is unavailable", async () => {
		mockLiquidGlassAvailable.mockReturnValue(false);
		const { getByText, queryByTestId } = renderWithProviders(
			<GlassSurface>
				<Text>Fallback content</Text>
			</GlassSurface>,
		);

		await waitFor(() => expect(getByText("Fallback content")).toBeTruthy());
		expect(queryByTestId("native-glass")).toBeNull();
	});

	it("honors Reduce Transparency", async () => {
		let resolvePreference: ((enabled: boolean) => void) | undefined;
		jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(
			new Promise((resolve) => {
				resolvePreference = resolve;
			}),
		);
		const { getByText, queryByTestId } = renderWithProviders(
			<GlassSurface>
				<Text>Accessible content</Text>
			</GlassSurface>,
		);

		await act(async () => resolvePreference?.(true));
		await waitFor(() => expect(queryByTestId("native-glass")).toBeNull());
		expect(getByText("Accessible content")).toBeTruthy();
	});

	it("uses the fallback without reading iOS accessibility APIs on web", async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
		try {
			const { getByText, queryByTestId } = renderWithProviders(
				<GlassSurface>
					<Text>Web content</Text>
				</GlassSurface>,
			);

			await waitFor(() => expect(getByText("Web content")).toBeTruthy());
			expect(queryByTestId("native-glass")).toBeNull();
			expect(
				AccessibilityInfo.isReduceTransparencyEnabled,
			).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(Platform, "OS", {
				configurable: true,
				value: originalPlatform,
			});
		}
	});
});

import AsyncStorage from "@react-native-async-storage/async-storage";
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

		await waitFor(() => expect(getByText("Accessible content")).toBeTruthy());
		expect(queryByTestId("native-glass")).toBeNull();
		await act(async () => resolvePreference?.(true));
		await waitFor(() => expect(queryByTestId("native-glass")).toBeNull());
		expect(getByText("Accessible content")).toBeTruthy();
	});

	it.each([
		["light", "#f2f2f7"],
		["dark", "#2c2c2e"],
	])("uses a solid %s fallback while the preference is unknown", async (theme, color) => {
		jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce(theme);
		let resolvePreference: ((enabled: boolean) => void) | undefined;
		jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(
			new Promise((resolve) => {
				resolvePreference = resolve;
			}),
		);
		const { getByText, getByLabelText, queryByTestId } = renderWithProviders(
			<GlassSurface
				accessibilityLabel="Glass surface"
				style={{ backgroundColor: "transparent" }}
			>
				<Text>Pending content</Text>
			</GlassSurface>,
		);

		await waitFor(() => expect(getByText("Pending content")).toBeTruthy());
		expect(queryByTestId("native-glass")).toBeNull();
		expect(getByLabelText("Glass surface")).toHaveStyle({
			backgroundColor: color,
		});
		await act(async () => resolvePreference?.(false));
		expect(queryByTestId("native-glass")).toBeTruthy();
	});

	it.each([
		true,
		false,
	])("does not overwrite a newer Reduce Transparency event (%s) with the initial query", async (enabled) => {
		let resolvePreference: ((value: boolean) => void) | undefined;
		jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(
			new Promise((resolve) => {
				resolvePreference = resolve;
			}),
		);
		const { getByText, queryByTestId, unmount } = renderWithProviders(
			<GlassSurface>
				<Text>Live preference</Text>
			</GlassSurface>,
		);
		await waitFor(() => expect(getByText("Live preference")).toBeTruthy());
		const listener = jest
			.mocked(AccessibilityInfo.addEventListener)
			.mock.calls.find(([event]) => event === "reduceTransparencyChanged")?.[1];
		expect(listener).toEqual(expect.any(Function));

		act(() => listener?.(enabled));
		expect(Boolean(queryByTestId("native-glass"))).toBe(!enabled);
		await act(async () => resolvePreference?.(!enabled));
		expect(Boolean(queryByTestId("native-glass"))).toBe(!enabled);

		act(() => listener?.(!enabled));
		expect(Boolean(queryByTestId("native-glass"))).toBe(enabled);
		unmount();
		expect(
			jest.mocked(AccessibilityInfo.addEventListener).mock.results[0].value
				.remove,
		).toHaveBeenCalledTimes(1);
	});

	it("keeps the opaque fallback if the preference query fails", async () => {
		jest
			.mocked(AccessibilityInfo.isReduceTransparencyEnabled)
			.mockRejectedValue(new Error("Unavailable"));
		const { getByText, getByLabelText, queryByTestId } = renderWithProviders(
			<GlassSurface accessibilityLabel="Glass surface">
				<Text>Fallback content</Text>
			</GlassSurface>,
		);
		await waitFor(() => expect(getByText("Fallback content")).toBeTruthy());
		expect(queryByTestId("native-glass")).toBeNull();
		expect(getByLabelText("Glass surface")).toHaveStyle({
			backgroundColor: "#f2f2f7",
		});
	});

	it("preserves an explicit fallbackStyle override", async () => {
		jest
			.mocked(AccessibilityInfo.isReduceTransparencyEnabled)
			.mockResolvedValue(true);
		const { getByText, getByLabelText, queryByTestId } = renderWithProviders(
			<GlassSurface
				accessibilityLabel="Glass surface"
				fallbackStyle={{ backgroundColor: "#123456" }}
			>
				<Text>Custom fallback</Text>
			</GlassSurface>,
		);
		await waitFor(() => expect(getByText("Custom fallback")).toBeTruthy());
		expect(queryByTestId("native-glass")).toBeNull();
		expect(getByLabelText("Glass surface")).toHaveStyle({
			backgroundColor: "#123456",
		});
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

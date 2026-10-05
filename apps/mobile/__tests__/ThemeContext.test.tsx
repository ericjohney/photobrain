const mockReadEnvelope = jest.fn();
const mockInitializeEnvelope = jest.fn();
const mockSetTheme = jest.fn();
const mockSetActiveScanId = jest.fn();
const mockRequireNativeModule = jest.fn(() => ({
	readEnvelope: mockReadEnvelope,
	initializeEnvelope: mockInitializeEnvelope,
	setTheme: mockSetTheme,
	setActiveScanId: mockSetActiveScanId,
}));

// Intercept only the bridge: Expo's lazy winter `fetch` global also resolves
// native modules through `requireNativeModule` (Node 22 reads it during setup).
jest.mock("expo-modules-core", () => {
	const actual = jest.requireActual("expo-modules-core");
	return {
		...actual,
		requireNativeModule: (name: string) =>
			name === "PhotoBrainMigrationBridge"
				? mockRequireNativeModule(name)
				: actual.requireNativeModule(name),
	};
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Appearance, Platform, Pressable, Text } from "react-native";
import { getActiveScanId, getThemePreference } from "@/lib/migration-bridge";
import { ThemeProvider, useTheme } from "@/theme";

const originalPlatform = Platform.OS;

function setPlatform(os: string) {
	Object.defineProperty(Platform, "OS", { configurable: true, value: os });
}

function ThemeProbe() {
	const { isDark, setThemePreference, themePreference } = useTheme();
	return (
		<>
			<Text>{`${themePreference}:${isDark ? "dark" : "light"}`}</Text>
			<Pressable
				accessibilityRole="button"
				onPress={() => setThemePreference("light")}
			>
				<Text>Use Light</Text>
			</Pressable>
		</>
	);
}

describe("ThemeProvider", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		setPlatform("ios");
		jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
		mockReadEnvelope.mockResolvedValue({ status: "absent" });
		mockInitializeEnvelope.mockResolvedValue(true);
		mockSetTheme.mockResolvedValue(true);
		mockSetActiveScanId.mockResolvedValue(true);
		jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
		setPlatform(originalPlatform);
	});

	it("loads a valid native envelope without consulting legacy storage", async () => {
		mockReadEnvelope.mockResolvedValueOnce({
			status: "valid",
			envelope: { schemaVersion: 1, theme: "dark", activeScanId: null },
		});

		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText("dark:dark")).toBeTruthy());
		expect(mockRequireNativeModule).toHaveBeenCalledWith(
			"PhotoBrainMigrationBridge",
		);
		expect(AsyncStorage.getItem).not.toHaveBeenCalled();
		expect(Appearance.setColorScheme).toHaveBeenCalledWith("dark");
	});

	it("seeds both legacy fields before a theme-first load returns", async () => {
		const jobId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
		jest.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
			if (key === "@photobrain/theme") return "dark";
			if (key === "@photobrain/active-scan") return jobId;
			return null;
		});
		mockInitializeEnvelope.mockImplementationOnce(
			async (theme, activeScanId) => {
				mockReadEnvelope.mockResolvedValue({
					status: "valid",
					envelope: { schemaVersion: 1, theme, activeScanId },
				});
				return true;
			},
		);

		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText("dark:dark")).toBeTruthy());
		await expect(getActiveScanId()).resolves.toBe(jobId);
		expect(mockInitializeEnvelope).toHaveBeenCalledTimes(1);
		expect(mockInitializeEnvelope).toHaveBeenCalledWith("dark", jobId);
		expect(mockSetTheme).not.toHaveBeenCalled();
		expect(mockSetActiveScanId).not.toHaveBeenCalled();
	});

	it("serializes simultaneous absent-envelope initialization", async () => {
		const jobId = "d3ea6e61-d35f-43cf-bae7-fb6197289337";
		jest
			.mocked(AsyncStorage.getItem)
			.mockImplementation(async (key) =>
				key === "@photobrain/active-scan" ? jobId : "light",
			);

		await expect(
			Promise.all([getThemePreference(), getActiveScanId()]),
		).resolves.toEqual(["light", jobId]);
		expect(mockInitializeEnvelope).toHaveBeenCalledTimes(1);
		expect(mockInitializeEnvelope).toHaveBeenCalledWith("light", jobId);
	});

	it.each([
		[
			"malformed",
			{ status: "valid", envelope: { schemaVersion: 1, theme: "dark" } },
		],
		[
			"unsupported",
			{
				status: "valid",
				envelope: { schemaVersion: 2, theme: "dark", activeScanId: null },
			},
		],
	])("fails closed for a %s native envelope", async (_case, nativeResult) => {
		mockReadEnvelope.mockResolvedValue(nativeResult);

		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText(/system:/)).toBeTruthy());
		expect(AsyncStorage.getItem).not.toHaveBeenCalled();

		fireEvent.press(getByText("Use Light"));

		await waitFor(() => expect(getByText("light:light")).toBeTruthy());
		expect(mockInitializeEnvelope).not.toHaveBeenCalled();
		expect(mockSetTheme).not.toHaveBeenCalled();
		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
	});

	it("retains AsyncStorage on Android without resolving the native module", async () => {
		setPlatform("android");
		jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("dark");

		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText("dark:dark")).toBeTruthy());
		expect(mockRequireNativeModule).not.toHaveBeenCalled();
		expect(mockReadEnvelope).not.toHaveBeenCalled();

		fireEvent.press(getByText("Use Light"));

		await waitFor(() => expect(getByText("light:light")).toBeTruthy());
		expect(AsyncStorage.setItem).toHaveBeenCalledWith(
			"@photobrain/theme",
			"light",
		);
	});

	it("does not resolve native modules or set native appearance on web", async () => {
		setPlatform("web");

		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText(/system:/)).toBeTruthy());
		expect(mockRequireNativeModule).not.toHaveBeenCalled();
		expect(mockReadEnvelope).not.toHaveBeenCalled();
		expect(Appearance.setColorScheme).not.toHaveBeenCalled();
	});
});

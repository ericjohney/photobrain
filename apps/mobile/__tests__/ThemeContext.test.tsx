import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Appearance, Platform, Pressable, Text } from "react-native";
import { ThemeProvider, useTheme } from "@/theme";

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
		jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
		jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("applies a persisted preference to native appearance", async () => {
		jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("dark");
		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);

		await waitFor(() => expect(getByText("dark:dark")).toBeTruthy());
		expect(Appearance.setColorScheme).toHaveBeenCalledWith("dark");
	});

	it("persists changes and updates native appearance", async () => {
		const { getByText } = render(
			<ThemeProvider>
				<ThemeProbe />
			</ThemeProvider>,
		);
		await waitFor(() => expect(getByText(/system:/)).toBeTruthy());

		fireEvent.press(getByText("Use Light"));

		await waitFor(() => expect(getByText("light:light")).toBeTruthy());
		expect(AsyncStorage.setItem).toHaveBeenCalledWith(
			"@photobrain/theme",
			"light",
		);
		expect(Appearance.setColorScheme).toHaveBeenCalledWith("light");
	});

	it("does not call the unavailable native appearance setter on web", async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
		try {
			const { getByText } = render(
				<ThemeProvider>
					<ThemeProbe />
				</ThemeProvider>,
			);

			await waitFor(() => expect(getByText(/system:/)).toBeTruthy());
			expect(Appearance.setColorScheme).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(Platform, "OS", {
				configurable: true,
				value: originalPlatform,
			});
		}
	});
});

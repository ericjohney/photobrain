import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Appearance, Platform, Pressable, Text } from "react-native";
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

function renderProbe() {
	return render(
		<ThemeProvider>
			<ThemeProbe />
		</ThemeProvider>,
	);
}

describe("ThemeProvider", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		setPlatform("ios");
		jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
		jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
		setPlatform(originalPlatform);
	});

	it("applies the saved theme and persists a new choice", async () => {
		jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("dark");

		const { getByText } = renderProbe();

		await waitFor(() => expect(getByText("dark:dark")).toBeTruthy());
		expect(AsyncStorage.getItem).toHaveBeenCalledWith("@photobrain/theme");
		expect(Appearance.setColorScheme).toHaveBeenCalledWith("dark");

		fireEvent.press(getByText("Use Light"));

		await waitFor(() => expect(getByText("light:light")).toBeTruthy());
		expect(AsyncStorage.setItem).toHaveBeenCalledWith(
			"@photobrain/theme",
			"light",
		);
		expect(Appearance.setColorScheme).toHaveBeenLastCalledWith("light");
	});

	it("falls back to the system theme for an unrecognized stored value", async () => {
		jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("sepia");

		const { getByText } = renderProbe();

		await waitFor(() => expect(getByText(/^system:/)).toBeTruthy());
		expect(Appearance.setColorScheme).toHaveBeenCalledWith("unspecified");
	});

	it("does not set native appearance on web", async () => {
		setPlatform("web");

		const { getByText } = renderProbe();

		await waitFor(() => expect(getByText(/^system:/)).toBeTruthy());
		expect(Appearance.setColorScheme).not.toHaveBeenCalled();
	});
});

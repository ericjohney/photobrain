import { waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import DashboardScreen from "@/screens/DashboardScreen";
import SearchScreen from "@/screens/SearchScreen";
import TabLayout from "../app/(tabs)/_layout";
import LibraryRoute from "../app/(tabs)/index";
import SearchLayout from "../app/(tabs)/search/_layout";
import SearchRoute from "../app/(tabs)/search/index";
import { renderWithProviders } from "./test-utils";

describe("active Expo Router navigation", () => {
	it("registers only the implemented Library and Search tabs", async () => {
		const { getByText, getByTestId, queryByText } = renderWithProviders(
			<TabLayout />,
		);

		await waitFor(() => expect(getByTestId("native-tabs")).toBeTruthy());
		expect(getByText("Library")).toBeTruthy();
		expect(getByText("Search")).toBeTruthy();
		expect(queryByText("Albums")).toBeNull();
	});

	it("maps tab routes to the current screen implementations", () => {
		expect(LibraryRoute).toBe(DashboardScreen);
		expect(SearchRoute).toBe(SearchScreen);
	});

	it("hides the native search header outside iOS", async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, "OS", {
			configurable: true,
			value: "android",
		});
		try {
			const { getByTestId } = renderWithProviders(<SearchLayout />);
			await waitFor(() => expect(getByTestId("native-stack")).toBeTruthy());
			expect(getByTestId("native-stack").props.screenOptions).toMatchObject({
				headerShown: false,
				headerTransparent: false,
			});
		} finally {
			Object.defineProperty(Platform, "OS", {
				configurable: true,
				value: originalPlatform,
			});
		}
	});
});

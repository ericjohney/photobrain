import { fireEvent, waitFor, within } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";
import PreferencesScreen from "@/screens/PreferencesScreen";
import { renderWithProviders } from "./test-utils";

describe("PreferencesScreen", () => {
	it("omits only the final row separator and still opens About", async () => {
		const { getByRole, UNSAFE_getAllByType } = renderWithProviders(
			<PreferencesScreen />,
		);
		const about = await waitFor(() =>
			getByRole("button", { name: "About PhotoBrain" }),
		);
		expect(about).toHaveStyle({ borderBottomWidth: 0 });
		const separatedRows = UNSAFE_getAllByType(View).filter(
			(row) =>
				StyleSheet.flatten(row.props.style)?.borderBottomWidth ===
				StyleSheet.hairlineWidth,
		);
		expect(separatedRows).toHaveLength(2);
		expect(within(separatedRows[0]).getByText("Server")).toBeTruthy();
		expect(within(separatedRows[1]).getByText("Interface")).toBeTruthy();
		fireEvent.press(about);
		expect(jest.requireMock("expo-router").__router.push).toHaveBeenCalledWith(
			"/about",
		);
	});
});

import { fireEvent, waitFor } from "@testing-library/react-native";

const mockReadLogEntries = jest.fn();

jest.mock("expo-updates", () => ({
	readLogEntriesAsync: (...args: unknown[]) => mockReadLogEntries(...args),
	isEmergencyLaunch: true,
	emergencyLaunchReason: "Previous update failed to launch",
	updateId: "failed-update-id",
}));

import { renderWithProviders } from "./test-utils";

process.env.EXPO_PUBLIC_STARTUP_DIAGNOSTICS = "true";
const { StartupDiagnostics } = require("../app/_layout");

describe("StartupDiagnostics", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockReadLogEntries.mockResolvedValue([
			{
				timestamp: Date.parse("2026-08-17T12:00:00.000Z"),
				level: "fatal",
				code: "JSRuntimeError",
				message: "Native component failed during startup",
				stacktrace: ["render@entry.js:10:2"],
			},
		]);
	});

	it("shows persisted Expo Updates startup errors as selectable text", async () => {
		const onContinue = jest.fn();
		const { getByText } = renderWithProviders(
			<StartupDiagnostics onContinue={onContinue} />,
		);

		await waitFor(() =>
			expect(getByText(/Native component failed during startup/)).toBeTruthy(),
		);
		const report = getByText(/Emergency launch: true/);
		expect(report.props.selectable).toBe(true);
		expect(getByText(/render@entry\.js:10:2/)).toBeTruthy();

		fireEvent.press(getByText("Try Normal App"));
		expect(onContinue).toHaveBeenCalledTimes(1);
	});
});

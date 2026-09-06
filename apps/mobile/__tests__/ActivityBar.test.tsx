import { render } from "@testing-library/react-native";
import ActivityBar from "@/components/ActivityBar";

jest.unmock("@/components/ActivityBar");

jest.mock("@/theme", () => ({
	useColors: () => require("@/theme/colors").colors.light,
}));

jest.mock("@/components/GlassSurface", () => ({
	__esModule: true,
	default: require("react-native").View,
}));

const unknownProgress = { phase: null, current: 0, total: 0, percentage: 0 };
const recoveryError = "Unable to check scan status. Retrying automatically.";

describe("ActivityBar", () => {
	it("shows checking status instead of processing while progress is unknown", () => {
		const { getByText, queryByText } = render(
			<ActivityBar progress={unknownProgress} isActive isCompleted={false} />,
		);

		expect(getByText("Checking scan status")).toBeTruthy();
		expect(queryByText("Processing")).toBeNull();
		expect(queryByText("Progress unavailable")).toBeNull();
	});

	it("explains automatic recovery without calling the scan failed", () => {
		const { getByText, queryByText, rerender } = render(
			<ActivityBar
				progress={unknownProgress}
				isActive
				isCompleted={false}
				error={recoveryError}
			/>,
		);

		expect(getByText("Progress unavailable")).toBeTruthy();
		expect(getByText(recoveryError)).toBeTruthy();
		expect(queryByText("Scan Failed")).toBeNull();
		expect(queryByText("Checking scan status")).toBeNull();

		rerender(
			<ActivityBar progress={unknownProgress} isActive isCompleted={false} />,
		);
		expect(getByText("Checking scan status")).toBeTruthy();
		expect(queryByText(recoveryError)).toBeNull();
	});

	it.each([
		["queued", "Scan Queued"],
		["processing", "Processing Photos"],
		["completed", "Complete"],
		["failed", "Scan Failed"],
	])("keeps the %s label when useful progress exists", (phase, label) => {
		const { getByText, queryByText } = render(
			<ActivityBar
				progress={{ ...unknownProgress, phase }}
				isActive={phase !== "completed" && phase !== "failed"}
				isCompleted={phase === "completed"}
				isFailed={phase === "failed"}
				failureMessage="Scan could not finish."
				error={recoveryError}
			/>,
		);

		expect(getByText(label)).toBeTruthy();
		expect(queryByText("Progress unavailable")).toBeNull();
		expect(queryByText(recoveryError)).toBeNull();
		if (phase === "failed") {
			expect(getByText("Scan could not finish.")).toBeTruthy();
		}
	});

	it("stays hidden without an active or terminal job", () => {
		const { toJSON } = render(
			<ActivityBar
				progress={unknownProgress}
				isActive={false}
				isCompleted={false}
				error={recoveryError}
			/>,
		);

		expect(toJSON()).toBeNull();
	});
});

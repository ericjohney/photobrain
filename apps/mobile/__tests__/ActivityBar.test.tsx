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
		["queued", "Scan Queued", "Waiting for the background service"],
		[
			"discovering",
			"Discovering Photos",
			"Finding supported photos in your library",
		],
		[
			"processing",
			"Preparing Photos",
			"Reading metadata and creating thumbnails",
		],
		[
			"scan-complete",
			"Starting Search Index",
			"Photo scan finished; search indexing starts next",
		],
		[
			"embedding",
			"Building Search Index",
			"Generating CLIP embeddings for semantic search",
		],
		["completed", "Library Up to Date", "Photos and semantic search are ready"],
		[
			"failed",
			"Scan Failed",
			"The library update stopped before it could finish",
		],
	])("explains the %s phase", (phase, label, detail) => {
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
		expect(getByText(detail)).toBeTruthy();
		expect(queryByText("Progress unavailable")).toBeNull();
		expect(queryByText(recoveryError)).toBeNull();
		if (phase === "failed") {
			expect(getByText("Scan could not finish.")).toBeTruthy();
		}
	});

	it("shows searchable indexing as the final pipeline stage", () => {
		const { getByLabelText, getByText } = render(
			<ActivityBar
				progress={{
					phase: "embedding",
					current: 1234,
					total: 2000,
					percentage: 62,
				}}
				isActive
				isCompleted={false}
			/>,
		);

		expect(getByText("1,234 of 2,000")).toBeTruthy();
		expect(getByText("62%")).toBeTruthy();
		expect(getByLabelText("Scan pipeline: stage 3 of 3")).toBeTruthy();
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

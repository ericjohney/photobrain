import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, waitFor } from "@testing-library/react-native";

const mockPhotosRefetch = jest.fn();
const mockFilterOptionsRefetch = jest.fn();
let mockPhotosError = false;
let mockPhotosHaveData = true;
let mockScanResult: {
	success: boolean;
	jobId?: string;
	error?: string;
} = { success: true, jobId: "test-job-123" };

jest.mock("@/lib/trpc", () => ({
	trpc: {
		photos: {
			useQuery: jest.fn((input: { camera?: string }) => {
				const photos = input.camera ? [] : require("./fixtures").MOCK_PHOTOS;
				return {
					data: mockPhotosHaveData
						? { photos, total: photos.length, rawCount: 2 }
						: undefined,
					isLoading: false,
					isFetching: false,
					isError: mockPhotosError,
					error: mockPhotosError ? new Error("Server unavailable") : null,
					refetch: mockPhotosRefetch,
				};
			}),
		},
		filterOptions: {
			useQuery: () => ({
				data: {
					cameras: ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"],
					lenses: [
						"FE 24-70mm f/2.8 GM",
						"FE 85mm f/1.4 GM",
						"RF 15-35mm f/2.8L IS USM",
					],
					isos: [100, 200, 400, 800, 3200],
					dates: ["2024-06", "2024-07", "2024-08"],
				},
				refetch: mockFilterOptionsRefetch,
			}),
		},
		scan: {
			useMutation: (options?: {
				onSuccess?: (result: typeof mockScanResult) => void;
			}) => ({
				mutate: jest.fn(() => options?.onSuccess?.(mockScanResult)),
				isPending: false,
			}),
		},
	},
}));

import DashboardScreen from "@/screens/DashboardScreen";
import { renderWithProviders } from "./test-utils";

describe("DashboardScreen", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockPhotosError = false;
		mockPhotosHaveData = true;
		mockScanResult = { success: true, jobId: "test-job-123" };
	});

	it("renders the library summary and date timeline", async () => {
		const { getByText } = renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByText("Library")).toBeTruthy());
		expect(getByText("5 Photos")).toBeTruthy();
		expect(getByText("August 2024")).toBeTruthy();
		expect(getByText("July 2024")).toBeTruthy();
		expect(getByText("June 2024")).toBeTruthy();
	});

	it("renders tiny thumbnails and RAW badges", async () => {
		const { getAllByTestId, getByText } = renderWithProviders(
			<DashboardScreen />,
		);

		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(5));
		for (const image of getAllByTestId("expo-image")) {
			expect(image.props.sourceUri).toContain("/thumbnail/tiny");
		}
		expect(getByText("ARW")).toBeTruthy();
		expect(getByText("CR2")).toBeTruthy();
	});

	it("opens and closes the loupe with the selected photo", async () => {
		const { getByLabelText, getByTestId, getByText, queryByTestId } =
			renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByTestId("photo-thumbnail-5")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-5"));

		await waitFor(() => expect(getByTestId("loupe-view")).toBeTruthy());
		expect(getByText("Info")).toBeTruthy();
		expect(getByText(/4000 × 6000/)).toBeTruthy();
		expect(getByText(/3\.1 MB/)).toBeTruthy();

		fireEvent.press(getByLabelText("Close photo"));
		await waitFor(() => expect(queryByTestId("loupe-view")).toBeNull());
	});

	it("does not retain stale loupe metadata between photos", async () => {
		const { getByLabelText, getByTestId, getByText, queryByText } =
			renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByTestId("photo-thumbnail-5")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-5"));
		await waitFor(() => expect(getByText(/3\.1 MB/)).toBeTruthy());
		fireEvent.press(getByLabelText("Close photo"));

		await waitFor(() => expect(getByTestId("photo-thumbnail-1")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-1"));
		await waitFor(() => expect(getByText(/4\.3 MB/)).toBeTruthy());
		expect(getByText(/6000 × 4000/)).toBeTruthy();
		expect(queryByText(/4000 × 6000/)).toBeNull();
	});

	it("swipes through photos in the same newest-first order as the grid", async () => {
		const { FlatList } = require("react-native");
		const { getByTestId, getByText, UNSAFE_getAllByType } = renderWithProviders(
			<DashboardScreen />,
		);

		await waitFor(() => expect(getByTestId("photo-thumbnail-3")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-3"));
		await waitFor(() => expect(getByText(/7360 × 4912/)).toBeTruthy());

		const gallery = UNSAFE_getAllByType(FlatList).find(
			(list) => list.props.testID === "loupe-gallery",
		);
		expect(gallery).toBeTruthy();
		if (!gallery) throw new Error("Expected loupe gallery");
		fireEvent(gallery, "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 2250, y: 0 } },
		});

		await waitFor(() => expect(getByText(/4\.3 MB/)).toBeTruthy());
		expect(getByText(/6000 × 4000/)).toBeTruthy();
	});

	it("refreshes photos and filter options", async () => {
		const { UNSAFE_root, getByText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => expect(getByText("Library")).toBeTruthy());

		const flatList = UNSAFE_root.findAllByType(
			require("react-native").FlatList,
		)[0];
		flatList.props.refreshControl.props.onRefresh();

		expect(mockPhotosRefetch).toHaveBeenCalledTimes(1);
		expect(mockFilterOptionsRefetch).toHaveBeenCalledTimes(1);
	});

	it("shows a retry action when the library query fails", async () => {
		mockPhotosError = true;
		mockPhotosHaveData = false;
		const { getByText } = renderWithProviders(<DashboardScreen />);

		await waitFor(() =>
			expect(getByText("Couldn't Load Library")).toBeTruthy(),
		);
		fireEvent.press(getByText("Try Again"));
		expect(mockPhotosRefetch).toHaveBeenCalledTimes(1);
		expect(mockFilterOptionsRefetch).toHaveBeenCalledTimes(1);
	});

	it("keeps cached library data visible when a refetch fails", async () => {
		mockPhotosError = true;
		const { getByText, queryByText } = renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByText("Library")).toBeTruthy());
		expect(getByText("5 Photos")).toBeTruthy();
		expect(queryByText("Couldn't Load Library")).toBeNull();
	});

	it("offers a clear action when filters produce an empty library", async () => {
		const { getByLabelText, getByText } = renderWithProviders(
			<DashboardScreen />,
		);
		await waitFor(() => expect(getByText("Library")).toBeTruthy());

		fireEvent.press(getByLabelText("Filter photos"));
		fireEvent.press(getByText("Sony A7III"));
		fireEvent.press(getByLabelText("Apply filters"));

		await waitFor(() =>
			expect(getByText("No photos match your filters")).toBeTruthy(),
		);
		fireEvent.press(getByText("Clear Filters"));
		await waitFor(() => expect(getByText("5 Photos")).toBeTruthy());
	});

	it("persists only successfully created scan jobs", async () => {
		const successful = renderWithProviders(<DashboardScreen />);
		await waitFor(() =>
			expect(successful.getByLabelText("Scan library")).toBeTruthy(),
		);
		fireEvent.press(successful.getByLabelText("Scan library"));
		await waitFor(() =>
			expect(AsyncStorage.setItem).toHaveBeenCalledWith(
				"@photobrain/active-scan",
				"test-job-123",
			),
		);
		successful.unmount();

		jest.mocked(AsyncStorage.setItem).mockClear();
		mockScanResult = { success: false, error: "Database unavailable" };
		const failed = renderWithProviders(<DashboardScreen />);
		await waitFor(() =>
			expect(failed.getByLabelText("Scan library")).toBeTruthy(),
		);
		fireEvent.press(failed.getByLabelText("Scan library"));
		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
		expect(failed.getByText("Database unavailable")).toBeTruthy();
	});

	it("opens settings from the library header", async () => {
		const { __router } = require("expo-router");
		const { getByLabelText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => expect(getByLabelText("Open settings")).toBeTruthy());

		fireEvent.press(getByLabelText("Open settings"));
		expect(__router.push).toHaveBeenCalledWith("/preferences");
	});
});

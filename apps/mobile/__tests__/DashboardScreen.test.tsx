import AsyncStorage from "@react-native-async-storage/async-storage";
import {
	fireEvent,
	type RenderResult,
	waitFor,
} from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { FlatList, StyleSheet } from "react-native";

const mockPhotosRefetch = jest.fn();
const mockFilterOptionsRefetch = jest.fn();
let mockPhotosError = false;
let mockPhotosHaveData = true;
let mockFilteredPhotosError = false;
let mockScanResult: {
	success: boolean;
	jobId?: string;
	error?: string;
} = { success: true, jobId: "test-job-123" };

jest.unmock("@/components/MetadataPanel");
jest.mock("@/lib/trpc", () => ({
	trpc: {
		photos: {
			useQuery: jest.fn(
				(input: { camera?: string; filterRaw?: "raw" | "standard" }) => {
					const filteredRequestFailed =
						input.camera !== undefined && mockFilteredPhotosError;
					const photos = input.camera
						? []
						: require("./fixtures").MOCK_PHOTOS.filter(
								(photo: { isRaw: boolean }) =>
									!input.filterRaw ||
									photo.isRaw === (input.filterRaw === "raw"),
							);
					return {
						data:
							mockPhotosHaveData && !filteredRequestFailed
								? { photos, total: photos.length, rawCount: 2 }
								: undefined,
						isLoading: false,
						isFetching: false,
						isError: mockPhotosError || filteredRequestFailed,
						error:
							mockPhotosError || filteredRequestFailed
								? new Error("Server unavailable")
								: null,
						refetch: mockPhotosRefetch,
					};
				},
			),
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

import { TabBarVisibilityContext } from "@/navigation/tab-bar-visibility";
import DashboardScreen from "@/screens/DashboardScreen";
import { MOCK_PHOTOS } from "./fixtures";
import { renderWithProviders } from "./test-utils";

function scrollLibrary(view: RenderResult, offset: number, photoId = 5) {
	const grid = view
		.UNSAFE_getAllByType(FlatList)
		.find((list) => list.props.testID === "library-grid");
	if (!grid) throw new Error("Expected library grid");
	const index = grid.props.data.findIndex(
		(item: { type: string; photos?: Array<{ id: number }> }) =>
			item.type === "photo-row" &&
			item.photos?.some((photo) => photo.id === photoId),
	);
	const item = grid.props.data[index];
	fireEvent(grid, "viewableItemsChanged", {
		viewableItems: [{ item, index, key: item.key, isViewable: true }],
		changed: [],
	});
	fireEvent.scroll(view.getByTestId("library-grid"), {
		nativeEvent: {
			contentOffset: { x: 0, y: offset },
			contentSize: { width: 375, height: 2000 },
			layoutMeasurement: { width: 375, height: 600 },
		},
	});
}

function capturedDate(photoId: number) {
	const photo = MOCK_PHOTOS.find((item) => item.id === photoId);
	if (!photo?.exif?.dateTaken) throw new Error("Expected fixture date");
	return new Date(photo.exif.dateTaken).toLocaleDateString(undefined, {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

describe("DashboardScreen", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();
		mockPhotosError = false;
		mockPhotosHaveData = true;
		mockFilteredPhotosError = false;
		mockScanResult = { success: true, jobId: "test-job-123" };
	});
	afterEach(() => jest.useRealTimers());

	it("renders library controls and the ungrouped grid", async () => {
		const { getByLabelText, getByText, queryByText } = renderWithProviders(
			<DashboardScreen />,
		);

		await waitFor(() => expect(getByText("Library")).toBeTruthy());
		expect(getByText("5 Items")).toBeTruthy();
		expect(getByText("Select")).toBeTruthy();
		expect(getByLabelText("Library options")).toBeTruthy();
		expect(queryByText("August 2024")).toBeNull();
	});

	it("uses five edge-to-edge columns on compact phones", async () => {
		const ReactNative = require("react-native");
		const dimensions = jest
			.spyOn(ReactNative, "useWindowDimensions")
			.mockReturnValue({ width: 375, height: 812, scale: 3, fontScale: 1 });
		try {
			const { getByTestId } = renderWithProviders(<DashboardScreen />);
			const thumbnail = await waitFor(() => getByTestId("photo-thumbnail-5"));
			const style = StyleSheet.flatten(thumbnail.props.style);

			expect(style.width).toBeCloseTo((375 - 4) / 5);
			expect(style.height).toBe(style.width);
		} finally {
			dimensions.mockRestore();
		}
	});

	it("reveals iOS-style browsing controls away from the newest edge", async () => {
		const setTabBarHidden = jest.fn();
		const view = renderWithProviders(
			<TabBarVisibilityContext.Provider value={setTabBarHidden}>
				<DashboardScreen />
			</TabBarVisibilityContext.Provider>,
		);
		await view.findByText("5 Items");

		expect(view.queryByTestId("library-browsing-bar")).toBeNull();
		expect(setTabBarHidden).toHaveBeenLastCalledWith(false);
		scrollLibrary(view, 1400);
		expect(view.queryByTestId("library-browsing-bar")).toBeNull();

		scrollLibrary(view, 1000, 4);
		expect(view.getByTestId("library-browsing-bar")).toBeTruthy();
		expect(view.getByRole("tab", { name: "All", selected: true })).toBeTruthy();
		expect(view.queryByRole("tab", { name: "All Photos" })).toBeNull();
		expect(view.getByLabelText("Show Collections")).toBeTruthy();
		expect(view.getByLabelText("Search Photos")).toBeTruthy();
		const router = require("expo-router").__router;
		fireEvent.press(view.getByLabelText("Show Collections"));
		expect(router.push).toHaveBeenCalledWith("/collections");
		fireEvent.press(view.getByLabelText("Search Photos"));
		expect(router.push).toHaveBeenCalledWith("/search");
		expect(setTabBarHidden).toHaveBeenLastCalledWith(true);

		scrollLibrary(view, 1400);
		expect(view.queryByTestId("library-browsing-bar")).toBeNull();
		expect(setTabBarHidden).toHaveBeenLastCalledWith(false);
	});

	it("uses Liquid Glass for each selected browsing scope", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		await view.findByText("5 Items");
		scrollLibrary(view, 1000);
		expect(view.getByRole("tab", { name: "All", selected: true })).toBeTruthy();
		await waitFor(() =>
			expect(
				view.getByTestId("library-scope-surface-all").props.glassEffectStyle,
			).toEqual({ style: "regular", animate: true }),
		);
		expect(
			view.getByTestId("library-scope-surface-months").props.glassEffectStyle,
		).toEqual({ style: "none", animate: true });
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		expect(
			view.getByRole("tab", { name: "Months", selected: true }),
		).toBeTruthy();
		expect(
			view.getByTestId("library-scope-surface-months").props.glassEffectStyle,
		).toEqual({ style: "regular", animate: true });
		expect(view.getByText("June 2024")).toBeTruthy();
		expect(view.getByText("July 2024")).toBeTruthy();
		expect(view.getByText("August 2024")).toBeTruthy();
		expect(view.getByText("5 Items")).toBeTruthy();
		fireEvent.press(view.getByRole("tab", { name: "Years" }));
		expect(
			view.getByRole("tab", { name: "Years", selected: true }),
		).toBeTruthy();
		expect(
			view.getByTestId("library-scope-surface-years").props.glassEffectStyle,
		).toEqual({ style: "regular", animate: true });
		expect(view.getByText("2024")).toBeTruthy();
		expect(view.queryByText("August 2024")).toBeNull();
		fireEvent.press(view.getByRole("tab", { name: "All" }));
		expect(view.queryByText("2024")).toBeNull();
		expect(view.getAllByTestId(/^photo-thumbnail-/)).toHaveLength(5);
	});

	it("renders sharper grid thumbnails and RAW badges", async () => {
		const { getAllByTestId, getByText } = renderWithProviders(
			<DashboardScreen />,
		);

		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(5));
		for (const image of getAllByTestId("expo-image")) {
			expect(image.props.sourceUri).toContain("/thumbnail/small");
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
		expect(getByTestId("loupe-gallery")).toBeTruthy();
		expect(Haptics.selectionAsync).not.toHaveBeenCalled();
		expect(getByLabelText("Show photo info")).toBeTruthy();
		expect(getByText("5 of 5")).toBeTruthy();

		fireEvent.press(getByLabelText("Close photo"));
		await waitFor(() => expect(queryByTestId("loupe-view")).toBeNull());
	});

	it("hides the browsing scope during selection and restores it on exit", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		await view.findByTestId("photo-thumbnail-5");
		scrollLibrary(view, 1000);
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		expect(
			view.getByRole("tab", { name: "Months", selected: true }),
		).toBeTruthy();
		fireEvent.press(view.getByLabelText("Select photos"));
		expect(view.queryByRole("tab", { name: "Months" })).toBeNull();
		expect(view.getByText("Select Items")).toBeTruthy();
		fireEvent.press(view.getByTestId("photo-thumbnail-5"));
		expect(view.getByText("1 Selected")).toBeTruthy();
		expect(
			view.getByRole("button", { name: "Deselect street.jpg", selected: true }),
		).toBeTruthy();
		expect(view.queryByTestId("loupe-view")).toBeNull();
		fireEvent.press(view.getByLabelText("Finish selecting photos"));
		expect(view.getByTestId("library-browsing-bar")).toBeTruthy();
		expect(
			view.getByRole("tab", { name: "Months", selected: true }),
		).toBeTruthy();
		fireEvent.press(view.getByLabelText("Select photos"));
		expect(view.getByText("Select Items")).toBeTruthy();
		expect(
			view.getByRole("button", { name: "Select street.jpg", selected: false }),
		).toBeTruthy();
	});

	it("keeps options and selection exit usable while browsing beneath the header", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		await view.findByTestId("photo-thumbnail-5");
		scrollLibrary(view, 180);
		expect(view.getByText(capturedDate(2))).toBeTruthy();
		expect(view.queryByText("5 Items")).toBeNull();
		fireEvent.press(view.getByLabelText("Library options"));
		expect(view.getByLabelText("Recently Added")).toBeTruthy();
		fireEvent.press(view.getByLabelText("Done"));

		fireEvent.press(view.getByLabelText("Select photos"));
		expect(view.getByText("Select Items")).toBeTruthy();
		fireEvent.press(view.getByTestId("photo-thumbnail-5"));
		expect(view.getByText("1 Selected")).toBeTruthy();
		expect(view.getAllByLabelText("Finish selecting photos")).toHaveLength(1);
		fireEvent.press(view.getByLabelText("Finish selecting photos"));
		expect(view.getByText(capturedDate(2))).toBeTruthy();
		expect(view.getByLabelText("Select photos")).toBeTruthy();
		scrollLibrary(view, 1400);
		await waitFor(() => expect(view.getByText("5 Items")).toBeTruthy());
	});

	it("does not retain stale loupe metadata between photos", async () => {
		const {
			getByLabelText,
			getByRole,
			getByTestId,
			getByText,
			queryByTestId,
			queryByText,
		} = renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByTestId("photo-thumbnail-5")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-5"));
		await waitFor(() => expect(getByText("5 of 5")).toBeTruthy());
		fireEvent.press(getByLabelText("Show photo info"));
		await waitFor(() =>
			expect(
				getByRole("button", { name: "File", expanded: true }),
			).toBeTruthy(),
		);
		expect(getByText("street.jpg")).toBeTruthy();
		expect(getByText("4000 x 6000")).toBeTruthy();
		fireEvent.press(getByLabelText("Close photo info"));
		fireEvent.press(getByLabelText("Close photo"));

		await waitFor(() => expect(getByTestId("photo-thumbnail-1")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-1"));
		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());
		expect(queryByText("4000 x 6000")).toBeNull();
		fireEvent.press(getByLabelText("Show photo info"));
		await waitFor(() =>
			expect(
				getByRole("button", { name: "File", expanded: true }),
			).toBeTruthy(),
		);
		expect(getByText("sunset.jpg")).toBeTruthy();
		expect(queryByText("street.jpg")).toBeNull();
		expect(getByText("6000 x 4000")).toBeTruthy();
		expect(queryByText("4000 x 6000")).toBeNull();
		fireEvent.press(getByLabelText("Close photo info"));
		fireEvent.press(getByLabelText("Close photo"));
		await waitFor(() => expect(queryByTestId("loupe-view")).toBeNull());
	});

	it("swipes through photos in the same oldest-to-newest order as the grid", async () => {
		const { FlatList } = require("react-native");
		const {
			getByLabelText,
			getByRole,
			getByTestId,
			getByText,
			queryByTestId,
			UNSAFE_getAllByType,
		} = renderWithProviders(<DashboardScreen />);

		await waitFor(() => expect(getByTestId("photo-thumbnail-3")).toBeTruthy());
		fireEvent.press(getByTestId("photo-thumbnail-3"));
		await waitFor(() => expect(getByText("3 of 5")).toBeTruthy());

		const gallery = UNSAFE_getAllByType(FlatList).find(
			(list) => list.props.testID === "loupe-gallery",
		);
		expect(gallery).toBeTruthy();
		if (!gallery) throw new Error("Expected loupe gallery");
		fireEvent(gallery, "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 2250, y: 0 } },
		});

		await waitFor(() => expect(getByText("4 of 5")).toBeTruthy());
		fireEvent.press(getByLabelText("Show photo info"));
		await waitFor(() =>
			expect(
				getByRole("button", { name: "File", expanded: true }),
			).toBeTruthy(),
		);
		expect(getByText("macro.cr2")).toBeTruthy();
		expect(getByText("5472 x 3648")).toBeTruthy();
		fireEvent.press(getByLabelText("Close photo info"));
		fireEvent.press(getByLabelText("Close photo"));
		await waitFor(() => expect(queryByTestId("loupe-view")).toBeNull());
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
		expect(getByText("5 Items")).toBeTruthy();
		expect(queryByText("Couldn't Load Library")).toBeNull();
	});

	it("offers a clear action when filters produce an empty library", async () => {
		const { getByLabelText, getByText } = renderWithProviders(
			<DashboardScreen />,
		);
		await waitFor(() => expect(getByText("Library")).toBeTruthy());

		fireEvent.press(getByLabelText("Library options"));
		fireEvent.press(getByLabelText("Filter"));
		fireEvent.press(getByLabelText("Camera"));
		fireEvent.press(getByText("Sony A7III"));
		fireEvent.press(getByLabelText("Done"));

		await waitFor(() =>
			expect(getByText("No photos match your filters")).toBeTruthy(),
		);
		fireEvent.press(getByText("Clear Filters"));
		await waitFor(() => expect(getByText("5 Items")).toBeTruthy());
	});

	it("keeps library options open when a filtered request fails", async () => {
		mockFilteredPhotosError = true;
		const { getByLabelText, getByText, queryByText } = renderWithProviders(
			<DashboardScreen />,
		);
		await waitFor(() => expect(getByLabelText("Library options")).toBeTruthy());

		fireEvent.press(getByLabelText("Library options"));
		fireEvent.press(getByLabelText("Filter"));
		fireEvent.press(getByLabelText("Camera"));
		fireEvent.press(getByText("Sony A7III"));

		await waitFor(() =>
			expect(getByLabelText("Retry filtered library")).toBeTruthy(),
		);
		expect(getByLabelText("Back to Filter")).toBeTruthy();
		fireEvent.press(getByLabelText("Back to Filter"));
		expect(getByLabelText("Clear all filters")).toBeTruthy();
		expect(getByText("Items Unavailable")).toBeTruthy();
		expect(queryByText("No photos match your filters")).toBeNull();
	});

	it("tracks the visible photo date in grouped timelines and resets changed contexts", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		await view.findByTestId("photo-thumbnail-5");
		scrollLibrary(view, 1000);
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		scrollLibrary(view, 1400);
		scrollLibrary(view, 320, 4);
		expect(view.getByText(capturedDate(4))).toBeTruthy();
		expect(view.queryByText(capturedDate(5))).toBeNull();

		fireEvent.press(view.getByRole("tab", { name: "All" }));
		expect(view.getByText("5 Items")).toBeTruthy();
		expect(view.queryByText(capturedDate(4))).toBeNull();

		scrollLibrary(view, 180);
		expect(view.getByText(capturedDate(2))).toBeTruthy();
		fireEvent.press(view.getByLabelText("Library options"));
		fireEvent.press(view.getByLabelText("Filter"));
		fireEvent.press(view.getByLabelText("RAW"));
		fireEvent.press(view.getByLabelText("Done"));
		expect(view.getByText("2 Items")).toBeTruthy();
		expect(view.queryByText(capturedDate(5))).toBeNull();
		fireEvent.press(view.getByLabelText("Show all items"));
		expect(view.getByText("5 Items")).toBeTruthy();
	});

	it("retains the browsing date during a cached refetch failure", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		await view.findByTestId("photo-thumbnail-5");
		scrollLibrary(view, 180);
		mockPhotosError = true;
		view.rerender(<DashboardScreen />);
		expect(view.getByText(capturedDate(2))).toBeTruthy();
		expect(view.queryByText("Couldn't Load Library")).toBeNull();
		scrollLibrary(view, 1400);
		expect(view.getByText("5 Items")).toBeTruthy();
	});

	it("filters RAW and standard photos, reopens filters directly, and resets from the grid", async () => {
		const view = renderWithProviders(<DashboardScreen />);
		fireEvent.press(await view.findByLabelText("Library options"));
		fireEvent.press(view.getByLabelText("Filter"));
		fireEvent.press(view.getByLabelText("RAW"));
		fireEvent.press(view.getByLabelText("Done"));
		expect(view.getByText("2 Items")).toBeTruthy();
		scrollLibrary(view, 1000, 2);
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		expect(view.getByText("June 2024")).toBeTruthy();
		expect(view.getByText("2 Items")).toBeTruthy();
		expect(view.getByTestId("photo-thumbnail-2")).toBeTruthy();
		expect(view.queryByTestId("photo-thumbnail-1")).toBeNull();
		expect(
			view.getByLabelText("Edit active filters").props.accessibilityValue.text,
		).toBe("RAW");
		fireEvent.press(view.getByLabelText("Edit active filters"));
		expect(view.getByLabelText("RAW").props.accessibilityState.checked).toBe(
			true,
		);
		fireEvent.press(view.getByLabelText("Standard"));
		fireEvent.press(view.getByLabelText("Done"));
		expect(view.getByText("3 Items")).toBeTruthy();
		expect(view.getByTestId("photo-thumbnail-1")).toBeTruthy();
		expect(view.queryByTestId("photo-thumbnail-2")).toBeNull();
		fireEvent.press(view.getByLabelText("Show all items"));
		expect(view.getByText("5 Items")).toBeTruthy();
		expect(
			view.getByRole("tab", { name: "Months", selected: true }),
		).toBeTruthy();
		expect(view.queryByLabelText("Edit active filters")).toBeNull();
	});

	it("sorts oldest-to-newest and returns to captured order for date grouping", async () => {
		const { FlatList } = require("react-native");
		const view = renderWithProviders(<DashboardScreen />);
		const photoIds = () =>
			view
				.UNSAFE_getAllByType(FlatList)[0]
				.props.data.filter(
					(item: { type: string }) => item.type === "photo-row",
				)
				.flatMap((item: { photos: Array<{ id: number }> }) =>
					item.photos.map((photo) => photo.id),
				);
		await view.findByLabelText("Library options");
		expect(photoIds()).toEqual([2, 1, 3, 4, 5]);
		scrollLibrary(view, 1000);
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		fireEvent.press(view.getByLabelText("Library options"));
		fireEvent.press(view.getByLabelText("Recently Added"));
		fireEvent.press(view.getByLabelText("Done"));
		expect(photoIds()).toEqual([1, 2, 3, 4, 5]);
		expect(view.queryByText("August 2024")).toBeNull();
		expect(view.queryByTestId("library-browsing-bar")).toBeNull();
		scrollLibrary(view, 1000);
		fireEvent.press(view.getByRole("tab", { name: "Months" }));
		expect(photoIds()).toEqual([2, 1, 3, 4, 5]);
		expect(
			view.getByRole("tab", { name: "Months", selected: true }),
		).toBeTruthy();
		fireEvent.press(view.getByLabelText("Library options"));
		expect(view.getByRole("radio", { name: "Date Captured" })).toBeChecked();
	});

	it("persists only successfully created scan jobs", async () => {
		const successful = renderWithProviders(<DashboardScreen />);
		await waitFor(() =>
			expect(successful.getByLabelText("Library options")).toBeTruthy(),
		);
		fireEvent.press(successful.getByLabelText("Library options"));
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
			expect(failed.getByLabelText("Library options")).toBeTruthy(),
		);
		fireEvent.press(failed.getByLabelText("Library options"));
		fireEvent.press(failed.getByLabelText("Scan library"));
		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
		expect(failed.getByText("Database unavailable")).toBeTruthy();
	});

	it("opens settings from library options", async () => {
		const { __router } = require("expo-router");
		const { getByLabelText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => expect(getByLabelText("Library options")).toBeTruthy());

		fireEvent.press(getByLabelText("Library options"));
		fireEvent.press(getByLabelText("Open settings"));
		expect(__router.push).toHaveBeenCalledWith("/preferences");
	});
});

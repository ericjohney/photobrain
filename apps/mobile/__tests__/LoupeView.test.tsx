import { act, fireEvent, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Dimensions, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import LoupeView from "@/components/LoupeView";
import { thumbnailUrl } from "@/config";
import { MOCK_PHOTOS, renderWithProviders } from "./test-utils";

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: jest.fn(),
	SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockOnClose = jest.fn();
const mockOnIndexChange = jest.fn();
const mockOnShowMetadata = jest.fn();

const defaultProps = {
	photos: MOCK_PHOTOS,
	initialIndex: 0,
	onClose: mockOnClose,
	onIndexChange: mockOnIndexChange,
	onShowMetadata: mockOnShowMetadata,
};

describe("LoupeView", () => {
	it("restores hidden controls by tapping a failed photo", async () => {
		const { findByTestId, getByTestId, getByLabelText, queryByLabelText } =
			renderWithProviders(<LoupeView {...defaultProps} />);
		const image = await findByTestId("expo-image");
		fireEvent.press(getByLabelText(MOCK_PHOTOS[0].name));
		expect(queryByLabelText("Close photo")).toBeNull();
		fireEvent(image, "error", { error: "offline" });
		fireEvent.press(getByTestId(`loupe-photo-error-${MOCK_PHOTOS[0].id}`));
		expect(getByLabelText("Close photo")).toBeTruthy();
		fireEvent.press(getByLabelText("Close photo"));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
	});

	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(useSafeAreaInsets).mockReturnValue({
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
		});
	});

	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it.each([
		false,
		true,
	])("insets chrome with an empty list: %s, keeping photos full bleed", async (empty) => {
		jest.mocked(useSafeAreaInsets).mockReturnValue({
			top: 20,
			bottom: 21,
			left: 44,
			right: 34,
		});
		const { getByTestId, getByLabelText, queryByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} photos={empty ? [] : MOCK_PHOTOS} />,
		);
		await waitFor(() => expect(getByTestId("loupe-top-bar")).toBeTruthy());
		expect(getByTestId("loupe-top-bar")).toHaveStyle({
			paddingTop: 28,
			paddingLeft: 58,
			paddingRight: 48,
		});
		fireEvent.press(getByLabelText("Close photo"));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
		if (empty) {
			expect(queryByTestId("loupe-gallery")).toBeNull();
			return;
		}
		expect(getByTestId("loupe-bottom-bar")).toHaveStyle({
			paddingBottom: 31,
			left: 56,
			right: 46,
		});
		const { width, height } = Dimensions.get("window");
		expect(getByLabelText(MOCK_PHOTOS[0].name)).toHaveStyle({ width, height });
		expect(getByTestId(`loupe-zoom-${MOCK_PHOTOS[0].id}`)).toHaveStyle({
			width,
			height,
		});
		expect(getByTestId("expo-image")).toHaveStyle({
			width: "100%",
			height: "100%",
		});
		expect(getByTestId("loupe-gallery").props.getItemLayout(null, 1)).toEqual({
			length: width,
			offset: width,
			index: 1,
		});
	});

	it.each([
		MOCK_PHOTOS[0],
		MOCK_PHOTOS[1],
	])("retries and recovers a failed $name thumbnail", async (photo) => {
		const {
			getByTestId,
			getByLabelText,
			getByText,
			queryByText,
			queryByTestId,
		} = renderWithProviders(<LoupeView {...defaultProps} photos={[photo]} />);
		const firstImage = await waitFor(() => getByTestId("expo-image"));
		const uri = thumbnailUrl(photo.id, "large");
		expect(firstImage.props.sourceUri).toBe(uri);
		fireEvent(firstImage, "error", { error: "Network failure" });
		expect(getByText("Unable to load photo")).toBeTruthy();
		expect(queryByTestId("expo-image")).toBeNull();
		expect(getByTestId(`loupe-zoom-${photo.id}`)).toBeTruthy();
		fireEvent.press(getByLabelText(`Retry loading ${photo.name}`));
		const retriedImage = getByTestId("expo-image");
		expect(retriedImage).not.toBe(firstImage);
		expect(retriedImage.props.sourceUri).toBe(uri);
		fireEvent(retriedImage, "load");
		expect(queryByText("Unable to load photo")).toBeNull();
		expect(queryByText("Retry")).toBeNull();
		expect(getByLabelText("Close photo")).toBeTruthy();
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenCalledWith(photo);
		fireEvent.press(getByLabelText(photo.name));
		expect(queryByTestId("loupe-top-bar")).toBeNull();
		fireEvent.press(getByLabelText(photo.name));
		expect(getByLabelText("Close photo")).toBeTruthy();
	});

	it("resets a photo error when its thumbnail version changes", async () => {
		const photo = {
			...MOCK_PHOTOS[0],
			thumbnailUpdatedAt: new Date("2026-01-01"),
		};
		const { getByTestId, getByText, queryByText, rerender } =
			renderWithProviders(<LoupeView {...defaultProps} photos={[photo]} />);
		fireEvent(await waitFor(() => getByTestId("expo-image")), "error", {
			error: "Missing",
		});
		expect(getByText("Retry")).toBeTruthy();
		rerender(<LoupeView {...defaultProps} photos={[{ ...photo }]} />);
		expect(getByText("Retry")).toBeTruthy();
		const updated = { ...photo, thumbnailUpdatedAt: new Date("2026-01-02") };
		rerender(<LoupeView {...defaultProps} photos={[updated]} />);
		expect(queryByText("Retry")).toBeNull();
		expect(getByTestId("expo-image").props.sourceUri).toBe(
			thumbnailUrl(updated.id, "large", updated.thumbnailUpdatedAt),
		);
	});

	it("keeps image errors isolated to their photo", async () => {
		jest.useFakeTimers();
		const { getByTestId, getByLabelText, queryByLabelText } =
			renderWithProviders(
				<LoupeView {...defaultProps} photos={MOCK_PHOTOS.slice(0, 2)} />,
			);
		fireEvent(await waitFor(() => getByTestId("expo-image")), "error", {
			error: "Missing",
		});
		expect(getByLabelText(`Retry loading ${MOCK_PHOTOS[0].name}`)).toBeTruthy();
		fireEvent(getByTestId("loupe-gallery"), "layout", {
			nativeEvent: { layout: { width: 750, height: 1334 } },
		});
		fireEvent(getByTestId("loupe-gallery"), "contentSizeChange", 1500, 1334);
		fireEvent.scroll(getByTestId("loupe-gallery"), {
			nativeEvent: {
				contentOffset: { x: 750, y: 0 },
				contentSize: { width: 1500, height: 1334 },
				layoutMeasurement: { width: 750, height: 1334 },
			},
		});
		await act(async () => jest.runOnlyPendingTimers());
		await waitFor(() =>
			expect(getByLabelText(MOCK_PHOTOS[1].name)).toBeTruthy(),
		);
		expect(queryByLabelText(`Retry loading ${MOCK_PHOTOS[1].name}`)).toBeNull();
		expect(getByLabelText(`Retry loading ${MOCK_PHOTOS[0].name}`)).toBeTruthy();
	});

	it("renders the current photo details and counter", async () => {
		const { getByText } = renderWithProviders(<LoupeView {...defaultProps} />);

		await waitFor(() => expect(getByText(/6000 × 4000/)).toBeTruthy());
		expect(getByText(/4\.3 MB/)).toBeTruthy();
		expect(getByText("1 of 5")).toBeTruthy();
	});

	it("shows only the implemented info action", async () => {
		const { getByText, queryByText } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);

		await waitFor(() => expect(getByText("Info")).toBeTruthy());
		expect(queryByText("Share")).toBeNull();
		expect(queryByText("Like")).toBeNull();
		expect(queryByText("Delete")).toBeNull();
	});

	it("closes from the accessible close control", async () => {
		const { getByLabelText } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Close photo")).toBeTruthy());

		fireEvent.press(getByLabelText("Close photo"));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
	});

	it("opens metadata with selection feedback", async () => {
		const { getByLabelText } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Show photo info")).toBeTruthy());

		fireEvent.press(getByLabelText("Show photo info"));
		expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
		expect(mockOnShowMetadata).toHaveBeenCalledWith(MOCK_PHOTOS[0]);
	});

	it("starts at a non-zero index without emitting a navigation event", async () => {
		const { getByText, queryByText } = renderWithProviders(
			<LoupeView {...defaultProps} initialIndex={3} />,
		);

		await waitFor(() => expect(getByText(/5472 × 3648/)).toBeTruthy());
		expect(getByText(/28\.6 MB/)).toBeTruthy();
		expect(getByText("4 of 5")).toBeTruthy();
		expect(queryByText(/4\.3 MB/)).toBeNull();
		expect(mockOnIndexChange).not.toHaveBeenCalled();
	});

	it("loads only the opening large thumbnail initially", async () => {
		const { getAllByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getAllByTestId("expo-image").length).toBe(1));

		expect(getAllByTestId("expo-image")[0].props.sourceUri).toContain(
			"/thumbnail/large",
		);
	});

	it("uses the core paged viewer and native iOS zoom", async () => {
		const { getByTestId, queryByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		const gallery = await waitFor(() => getByTestId("loupe-gallery"));

		expect(gallery.props.horizontal).toBe(true);
		expect(gallery.props.pagingEnabled).toBe(true);
		expect(gallery.props.initialNumToRender).toBe(1);
		expect(gallery.props.maxToRenderPerBatch).toBe(2);
		expect(queryByTestId("native-glass")).toBeNull();
		if (Platform.OS === "ios") {
			const zoom = getByTestId(`loupe-zoom-${MOCK_PHOTOS[0].id}`);
			expect(zoom.props.minimumZoomScale).toBe(1);
			expect(zoom.props.maximumZoomScale).toBe(5);
		}
	});

	it("updates details and callback after a gallery swipe", async () => {
		const { FlatList } = require("react-native");
		const { getByText, UNSAFE_getByType } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText(/4\.3 MB/)).toBeTruthy());

		fireEvent(UNSAFE_getByType(FlatList), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});

		await waitFor(() => expect(getByText(/23\.8 MB/)).toBeTruthy());
		expect(getByText("2 of 5")).toBeTruthy();
		expect(mockOnIndexChange).toHaveBeenCalledWith(1);
		expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
	});

	it("uses the drag target when a page settles without momentum", async () => {
		const { FlatList } = require("react-native");
		const { getByText, UNSAFE_getByType } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());

		fireEvent(UNSAFE_getByType(FlatList), "scrollEndDrag", {
			nativeEvent: {
				contentOffset: { x: 300, y: 0 },
				targetContentOffset: { x: 750, y: 0 },
			},
		});

		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());
		expect(mockOnIndexChange).toHaveBeenCalledWith(1);
	});

	it("can navigate back to the opening photo", async () => {
		const { FlatList } = require("react-native");
		const { getByText, UNSAFE_getByType } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());

		fireEvent(UNSAFE_getByType(FlatList), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});
		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());

		fireEvent(UNSAFE_getByType(FlatList), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 0, y: 0 } },
		});
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(0);
	});

	it("keeps the same photo active when the photo list is reordered", async () => {
		const { FlatList } = require("react-native");
		const { getByText, rerender, UNSAFE_getByType } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		fireEvent(UNSAFE_getByType(FlatList), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});
		await waitFor(() => expect(getByText(/23\.8 MB/)).toBeTruthy());

		rerender(
			<LoupeView
				{...defaultProps}
				photos={[MOCK_PHOTOS[1], MOCK_PHOTOS[0], ...MOCK_PHOTOS.slice(2)]}
			/>,
		);

		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		expect(getByText(/23\.8 MB/)).toBeTruthy();
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(0);
	});

	it("reports a replacement when the active photo is removed", async () => {
		const { FlatList } = require("react-native");
		const { getByText, rerender, UNSAFE_getByType } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		fireEvent(UNSAFE_getByType(FlatList), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});
		await waitFor(() => expect(getByText(/23\.8 MB/)).toBeTruthy());
		mockOnIndexChange.mockClear();

		rerender(
			<LoupeView
				{...defaultProps}
				photos={[MOCK_PHOTOS[0], ...MOCK_PHOTOS.slice(2)]}
			/>,
		);

		await waitFor(() => expect(getByText("2 of 4")).toBeTruthy());
		expect(getByText(/7\.6 MB/)).toBeTruthy();
		expect(mockOnIndexChange).toHaveBeenCalledWith(1);
	});
});

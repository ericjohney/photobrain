import { fireEvent, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";
import LoupeView from "@/components/LoupeView";
import { MOCK_PHOTOS, renderWithProviders } from "./test-utils";

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
	beforeEach(() => {
		jest.clearAllMocks();
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

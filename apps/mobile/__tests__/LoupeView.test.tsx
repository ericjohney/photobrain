import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Dimensions } from "react-native";
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
		await screen.findAllByTestId("native-glass");
		fireEvent.press(getByLabelText(MOCK_PHOTOS[0].name));
		expect(queryByLabelText("Close photo")).toBeNull();
		fireEvent(image, "error", { error: "offline" });
		fireEvent.press(getByTestId(`loupe-photo-error-${MOCK_PHOTOS[0].id}`));
		await screen.findAllByTestId("native-glass");
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

	it("can close when the photo list becomes empty", async () => {
		const { getByLabelText, queryByTestId, rerender } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Close photo")).toBeTruthy());
		await screen.findAllByTestId("native-glass");
		rerender(<LoupeView {...defaultProps} photos={[]} />);
		await screen.findAllByTestId("native-glass");
		expect(queryByTestId("loupe-gallery")).toBeNull();
		fireEvent.press(getByLabelText("Close photo"));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
	});

	it.each([
		MOCK_PHOTOS[0],
		MOCK_PHOTOS[1],
		{ ...MOCK_PHOTOS[0], name: "photo.heic", mimeType: "image/heic" },
	])("retries and recovers a failed $name thumbnail", async (photo) => {
		const {
			getByTestId,
			getByLabelText,
			getByText,
			queryByText,
			queryByTestId,
		} = renderWithProviders(<LoupeView {...defaultProps} photos={[photo]} />);
		const firstImage = await waitFor(() => getByTestId("expo-image"));
		await screen.findAllByTestId("native-glass");
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
		await screen.findAllByTestId("native-glass");
		expect(getByLabelText("Close photo")).toBeTruthy();
	});

	it("resets a photo error when its thumbnail version changes", async () => {
		const photo = {
			...MOCK_PHOTOS[0],
			thumbnailUpdatedAt: new Date("2026-01-01"),
		};
		const { getByTestId, getByText, queryByText, rerender } =
			renderWithProviders(<LoupeView {...defaultProps} photos={[photo]} />);
		await screen.findAllByTestId("native-glass");
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
		await screen.findAllByTestId("native-glass");
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

	it("closes from the accessible close control", async () => {
		const { getByLabelText } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Close photo")).toBeTruthy());
		await screen.findAllByTestId("native-glass");

		fireEvent.press(getByLabelText("Close photo"));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
	});

	it("opens metadata with selection feedback", async () => {
		const { getByLabelText } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Show photo info")).toBeTruthy());
		await screen.findAllByTestId("native-glass");

		fireEvent.press(getByLabelText("Show photo info"));
		expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
		expect(mockOnShowMetadata).toHaveBeenCalledWith(MOCK_PHOTOS[0]);
	});

	it("starts at a non-zero index without emitting a navigation event", async () => {
		const { getByText, getByLabelText } = renderWithProviders(
			<LoupeView {...defaultProps} initialIndex={3} />,
		);

		await waitFor(() => expect(getByText("4 of 5")).toBeTruthy());
		await screen.findAllByTestId("native-glass");
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenCalledWith(MOCK_PHOTOS[3]);
		expect(mockOnIndexChange).not.toHaveBeenCalled();
	});

	it("keeps thumbnail jumps, swipes, metadata and parent selection in sync", async () => {
		const { getByText, getByTestId, getByLabelText, queryByTestId } =
			renderWithProviders(<LoupeView {...defaultProps} />);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		await screen.findAllByTestId("native-glass");

		fireEvent.press(getByLabelText(`View photo 4: ${MOCK_PHOTOS[3].name}`));
		expect(getByText("4 of 5")).toBeTruthy();
		expect(
			getByLabelText(`View photo 4: ${MOCK_PHOTOS[3].name}`),
		).toBeSelected();
		expect(
			getByLabelText(`View photo 1: ${MOCK_PHOTOS[0].name}`),
		).not.toBeSelected();
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(3);
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenLastCalledWith(MOCK_PHOTOS[3]);

		fireEvent(getByTestId("loupe-gallery"), "momentumScrollEnd", {
			nativeEvent: {
				contentOffset: { x: Dimensions.get("window").width * 2, y: 0 },
			},
		});
		expect(getByText("3 of 5")).toBeTruthy();
		expect(
			getByLabelText(`View photo 3: ${MOCK_PHOTOS[2].name}`),
		).toBeSelected();
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(2);
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenLastCalledWith(MOCK_PHOTOS[2]);

		fireEvent.press(getByLabelText(`View photo 1: ${MOCK_PHOTOS[0].name}`));
		expect(getByText("1 of 5")).toBeTruthy();
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(0);
		fireEvent.press(getByLabelText(MOCK_PHOTOS[0].name));
		expect(queryByTestId("loupe-top-bar")).toBeNull();
		expect(queryByTestId("loupe-filmstrip")).toBeNull();
		fireEvent.press(getByLabelText(MOCK_PHOTOS[0].name));
		await screen.findAllByTestId("native-glass");
		expect(getByTestId("loupe-filmstrip")).toBeTruthy();
	});

	it("uses the drag target when a page settles without momentum", async () => {
		const { getByText, getByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		await screen.findAllByTestId("native-glass");

		fireEvent(getByTestId("loupe-gallery"), "scrollEndDrag", {
			nativeEvent: {
				contentOffset: { x: 300, y: 0 },
				targetContentOffset: { x: 750, y: 0 },
			},
		});

		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());
		expect(mockOnIndexChange).toHaveBeenCalledWith(1);
	});

	it("keeps the same photo active when the photo list is reordered", async () => {
		const { getByText, getByLabelText, getByTestId, rerender } =
			renderWithProviders(<LoupeView {...defaultProps} />);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		await screen.findAllByTestId("native-glass");
		fireEvent(getByTestId("loupe-gallery"), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});
		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());

		rerender(
			<LoupeView
				{...defaultProps}
				photos={[MOCK_PHOTOS[1], MOCK_PHOTOS[0], ...MOCK_PHOTOS.slice(2)]}
			/>,
		);

		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		expect(
			getByLabelText(`View photo 1: ${MOCK_PHOTOS[1].name}`),
		).toBeSelected();
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenLastCalledWith(MOCK_PHOTOS[1]);
		expect(mockOnIndexChange).toHaveBeenLastCalledWith(0);
	});

	it("reports a replacement when the active photo is removed", async () => {
		const { getByText, getByLabelText, getByTestId, rerender } =
			renderWithProviders(<LoupeView {...defaultProps} />);
		await waitFor(() => expect(getByText("1 of 5")).toBeTruthy());
		await screen.findAllByTestId("native-glass");
		fireEvent(getByTestId("loupe-gallery"), "momentumScrollEnd", {
			nativeEvent: { contentOffset: { x: 750, y: 0 } },
		});
		await waitFor(() => expect(getByText("2 of 5")).toBeTruthy());
		mockOnIndexChange.mockClear();

		rerender(
			<LoupeView
				{...defaultProps}
				photos={[MOCK_PHOTOS[0], ...MOCK_PHOTOS.slice(2)]}
			/>,
		);

		await waitFor(() => expect(getByText("2 of 4")).toBeTruthy());
		expect(
			getByLabelText(`View photo 2: ${MOCK_PHOTOS[2].name}`),
		).toBeSelected();
		fireEvent.press(getByLabelText("Show photo info"));
		expect(mockOnShowMetadata).toHaveBeenLastCalledWith(MOCK_PHOTOS[2]);
		expect(mockOnIndexChange).toHaveBeenCalledWith(1);
	});
});

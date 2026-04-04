import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { renderWithProviders, MOCK_PHOTOS } from "./test-utils";
import LoupeView from "@/components/LoupeView";

const mockOnClose = jest.fn();
const mockOnIndexChange = jest.fn();
const mockOnShowMetadata = jest.fn();

const defaultProps = {
	photos: MOCK_PHOTOS,
	initialIndex: 0,
	apiUrl: "http://test-api:3000",
	onClose: mockOnClose,
	onIndexChange: mockOnIndexChange,
	onShowMetadata: mockOnShowMetadata,
};

beforeEach(() => {
	jest.clearAllMocks();
});

describe("LoupeView", () => {
	it("renders the first photo's date and dimensions", async () => {
		const { getByText } = renderWithProviders(<LoupeView {...defaultProps} />);

		await waitFor(() => {
			expect(getByText(/6000 × 4000/)).toBeTruthy();
		});
		expect(getByText(/4\.3 MB/)).toBeTruthy();
	});

	it("renders all four action buttons", async () => {
		const { getByText } = renderWithProviders(<LoupeView {...defaultProps} />);

		await waitFor(() => {
			expect(getByText("Share")).toBeTruthy();
		});
		expect(getByText("Like")).toBeTruthy();
		expect(getByText("Info")).toBeTruthy();
		expect(getByText("Delete")).toBeTruthy();
	});

	it("calls onClose when back button is pressed", async () => {
		const { getByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);

		await waitFor(() => {
			expect(getByTestId("icon-chevron-back")).toBeTruthy();
		});
		fireEvent.press(getByTestId("icon-chevron-back"));
		expect(mockOnClose).toHaveBeenCalled();
	});

	it("calls onShowMetadata when Info button is pressed", async () => {
		const { getByText } = renderWithProviders(<LoupeView {...defaultProps} />);

		await waitFor(() => {
			expect(getByText("Info")).toBeTruthy();
		});
		fireEvent.press(getByText("Info"));
		expect(Haptics.selectionAsync).toHaveBeenCalled();
		expect(mockOnShowMetadata).toHaveBeenCalledWith(MOCK_PHOTOS[0]);
	});

	it("renders correct data when starting at a different index", async () => {
		const { getByText } = renderWithProviders(
			<LoupeView {...defaultProps} initialIndex={2} />,
		);

		await waitFor(() => {
			expect(getByText(/7360 × 4912/)).toBeTruthy();
		});
		expect(getByText(/7\.6 MB/)).toBeTruthy();
	});

	it("renders large thumbnail URIs", async () => {
		const { getAllByTestId } = renderWithProviders(
			<LoupeView {...defaultProps} />,
		);

		await waitFor(() => {
			const images = getAllByTestId("expo-image");
			expect(images.length).toBeGreaterThan(0);
		});

		const images = getAllByTestId("expo-image");
		const hasLargeThumbnail = images.some((img) =>
			img.props.accessibilityLabel?.includes("/thumbnail/large"),
		);
		expect(hasLargeThumbnail).toBe(true);
	});

	it("triggers haptic feedback on Share button press", async () => {
		const { getByText } = renderWithProviders(<LoupeView {...defaultProps} />);

		await waitFor(() => {
			expect(getByText("Share")).toBeTruthy();
		});
		fireEvent.press(getByText("Share"));
		expect(Haptics.selectionAsync).toHaveBeenCalled();
	});
});

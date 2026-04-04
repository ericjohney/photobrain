import React from "react";
import { fireEvent, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";

// tRPC mock — must go BEFORE the component import
jest.mock("@/lib/trpc", () => ({
	trpc: {
		photos: {
			useQuery: () => ({
				data: { photos: require("./fixtures").MOCK_PHOTOS },
				isLoading: false,
				isFetching: false,
				refetch: jest.fn(),
			}),
		},
		scan: {
			useMutation: (opts?: any) => ({
				mutate: jest.fn((...args: any[]) => {
					opts?.onSuccess?.({ jobId: "test-job-123" });
				}),
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
	});

	it("renders the PhotoBrain header", async () => {
		const { getByText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});
	});

	it("renders month headers from photo dates", async () => {
		const { getByText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getByText("August 2024")).toBeTruthy();
			expect(getByText("July 2024")).toBeTruthy();
			expect(getByText("June 2024")).toBeTruthy();
		});
	});

	it("renders photo thumbnails with correct URIs", async () => {
		const { getAllByTestId } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			const images = getAllByTestId("expo-image");
			const photoImages = images.filter((img) => {
				const label = img.props.accessibilityLabel || "";
				return (
					label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
				);
			});
			expect(photoImages.length).toBe(5);
		});
	});

	it("shows RAW badge on RAW photos", async () => {
		const { getByText } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getByText("ARW")).toBeTruthy();
			expect(getByText("CR2")).toBeTruthy();
		});
	});

	it("opens loupe view when a photo is tapped", async () => {
		const { getAllByTestId, getByText } = renderWithProviders(
			<DashboardScreen />,
		);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		const images = getAllByTestId("expo-image");
		const photoImage = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return (
				label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
			);
		});
		expect(photoImage).toBeTruthy();

		fireEvent.press(photoImage!);

		await waitFor(() => {
			expect(getByText("Share")).toBeTruthy();
			expect(getByText("Like")).toBeTruthy();
			expect(getByText("Info")).toBeTruthy();
			expect(getByText("Delete")).toBeTruthy();
		});
	});

	it("shows correct photo data in loupe after tap", async () => {
		const { getAllByTestId, getByText } = renderWithProviders(
			<DashboardScreen />,
		);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		const images = getAllByTestId("expo-image");
		// Tap the first photo thumbnail (street.jpg, id=5, sorted newest first in grid).
		const photoImage = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return (
				label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
			);
		});
		expect(photoImage).toBeTruthy();

		fireEvent.press(photoImage!);

		// Verify loupe renders with photo dimensions and file size
		await waitFor(() => {
			expect(getByText(/4000 × 6000/)).toBeTruthy();
			expect(getByText(/3\.1 MB/)).toBeTruthy();
		});
	});

	it("shows correct data when opening loupe on different photos sequentially", async () => {
		// Bug: opening loupe on photo A, closing, then opening on photo B
		// would sometimes show photo A's metadata due to stale FlatList state.
		const { getAllByTestId, getByText, getByTestId, queryByText } =
			renderWithProviders(<DashboardScreen />);

		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		// Tap first photo in grid (street.jpg, id=5 — newest first)
		const images = getAllByTestId("expo-image");
		const firstPhoto = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return label.includes("/api/photos/5/thumbnail/tiny");
		});
		expect(firstPhoto).toBeTruthy();
		fireEvent.press(firstPhoto!);

		// Verify street.jpg data: 4000×6000, 3.1 MB
		await waitFor(() => {
			expect(getByText(/4000 × 6000/)).toBeTruthy();
			expect(getByText(/3\.1 MB/)).toBeTruthy();
		});

		// Close loupe
		fireEvent.press(getByTestId("icon-chevron-back"));

		// Wait for grid to reappear
		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});

		// Now tap a DIFFERENT photo — find sunset.jpg (id=1)
		const images2 = getAllByTestId("expo-image");
		const secondPhoto = images2.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return label.includes("/api/photos/1/thumbnail/tiny");
		});
		expect(secondPhoto).toBeTruthy();
		fireEvent.press(secondPhoto!);

		// Verify sunset.jpg data: 6000×4000, 4.3 MB — NOT street.jpg's data
		await waitFor(() => {
			expect(getByText(/6000 × 4000/)).toBeTruthy();
			expect(getByText(/4\.3 MB/)).toBeTruthy();
		});

		// Confirm street.jpg's unique dimensions are NOT shown
		expect(queryByText(/4000 × 6000/)).toBeNull();
	});

	it("triggers haptic feedback on long press", async () => {
		const { getAllByTestId } = renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		const images = getAllByTestId("expo-image");
		const photoImage = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return (
				label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
			);
		});
		expect(photoImage).toBeTruthy();

		fireEvent(photoImage!, "longPress");

		expect(Haptics.impactAsync).toHaveBeenCalledWith(
			Haptics.ImpactFeedbackStyle.Medium,
		);
	});
});

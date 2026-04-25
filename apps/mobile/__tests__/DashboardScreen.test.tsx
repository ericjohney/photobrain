import { fireEvent, waitFor } from "@testing-library/react-native";
import React from "react";

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
		filterOptions: {
			useQuery: () => ({
				data: {
					cameras: ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"],
					lenses: ["FE 24-70mm f/2.8 GM", "FE 85mm f/1.4 GM", "RF 15-35mm f/2.8L IS USM"],
					isos: [100, 200, 400, 800, 3200],
					dates: ["2024-06", "2024-07", "2024-08"],
				},
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

	it("renders loupe in a Modal when photo is tapped", async () => {
		const { getAllByTestId, getByText, UNSAFE_getAllByType } =
			renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		// Find the loupe Modal (animationType="fade") — FilterSheet uses "slide"
		const { Modal } = require("react-native");
		const findLoupeModal = () =>
			UNSAFE_getAllByType(Modal).find(
				(m: any) => m.props.animationType === "fade",
			);

		// Modal should not be visible initially
		const modalBefore = findLoupeModal();
		expect(!modalBefore || modalBefore.props.visible === false).toBe(true);

		// Tap a photo to open loupe
		const images = getAllByTestId("expo-image");
		const photoImage = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return (
				label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
			);
		});
		expect(photoImage).toBeTruthy();
		fireEvent.press(photoImage!);

		// Modal should now be visible with loupe action buttons
		await waitFor(() => {
			const modal = findLoupeModal();
			expect(modal).toBeTruthy();
			expect(modal!.props.visible).toBe(true);
		});

		// Loupe action buttons should be present
		await waitFor(() => {
			expect(getByText("Share")).toBeTruthy();
			expect(getByText("Info")).toBeTruthy();
		});
	});

	it("closes the Modal when back button is pressed in loupe", async () => {
		const { getAllByTestId, getByTestId, UNSAFE_getAllByType } =
			renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		// Open loupe
		const images = getAllByTestId("expo-image");
		const photoImage = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return (
				label.includes("/api/photos/") && label.includes("/thumbnail/tiny")
			);
		});
		fireEvent.press(photoImage!);

		const { Modal } = require("react-native");
		const findLoupeModal = () =>
			UNSAFE_getAllByType(Modal).find(
				(m: any) => m.props.animationType === "fade",
			);

		await waitFor(() => {
			const modal = findLoupeModal();
			expect(modal?.props.visible).toBe(true);
		});

		// Press back button to close
		fireEvent.press(getByTestId("icon-chevron-back"));

		// Modal should be hidden
		await waitFor(() => {
			const modal = findLoupeModal();
			expect(!modal || modal.props.visible === false).toBe(true);
		});
	});

	it("swiping in loupe follows the grid's date order, not API order", async () => {
		// Photos in API order: sunset(1,Jun15), portrait(2,Jun15), landscape(3,Jul20), macro(4,Jul20), street(5,Aug5)
		// Grid sorts newest-first: street(5), macro(4), landscape(3), sunset(1), portrait(2)
		// Tapping landscape(3) and swiping to next should show sunset(1), NOT macro(4)
		const { getAllByTestId, getByText, UNSAFE_getAllByType } =
			renderWithProviders(<DashboardScreen />);
		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
		});

		// Tap landscape.jpg (id=3)
		const images = getAllByTestId("expo-image");
		const landscape = images.find((img) => {
			const label = img.props.accessibilityLabel || "";
			return label.includes("/api/photos/3/thumbnail/tiny");
		});
		expect(landscape).toBeTruthy();
		fireEvent.press(landscape!);

		// Verify loupe opens showing landscape.jpg: 7360×4912
		await waitFor(() => {
			expect(getByText(/7360 × 4912/)).toBeTruthy();
		});

		// Simulate swipe to next photo — must use UNSAFE_getAllByType to get
		// the FlatList component (not the host View) for events to dispatch.
		const { FlatList } = require("react-native");
		const allFlatLists = UNSAFE_getAllByType(FlatList);
		const loupeFlatList = allFlatLists.find(
			(fl: any) => fl.props.testID === "loupe-gallery",
		);
		expect(loupeFlatList).toBeTruthy();
		// landscape is at sorted index 2. Swiping one page right → index 3.
		// SCREEN_WIDTH is 750 in jest-expo. offset = (2+1) * 750 = 2250
		fireEvent(loupeFlatList!, "momentumScrollEnd", {
			nativeEvent: {
				contentOffset: { x: 2250, y: 0 },
				contentSize: { width: 3750, height: 800 },
				layoutMeasurement: { width: 750, height: 800 },
			},
		});

		// Next photo in date order after landscape(Jul20 8:15) is sunset(Jun15 18:30): 6000×4000, 4.3 MB
		// NOT macro(Jul20 10:30) which would be API-order neighbor
		await waitFor(() => {
			expect(getByText(/4\.3 MB/)).toBeTruthy();
			expect(getByText(/6000 × 4000/)).toBeTruthy();
		});
	});

	it("pull-to-refresh calls refetch", async () => {
		const refetchMock = jest.fn();
		const trpcModule = require("@/lib/trpc");
		const originalUseQuery = trpcModule.trpc.photos.useQuery;
		trpcModule.trpc.photos.useQuery = () => ({
			...originalUseQuery(),
			refetch: refetchMock,
		});

		try {
			const { getByTestId, UNSAFE_root } = renderWithProviders(
				<DashboardScreen />,
			);

			await waitFor(() => {
				expect(getByTestId("activity-bar")).toBeTruthy();
			});

			// Find the FlatList's RefreshControl by firing the refresh event on it
			const { RefreshControl } = require("react-native");
			const flatList = UNSAFE_root.findAllByType(
				require("react-native").FlatList,
			);
			expect(flatList.length).toBeGreaterThan(0);

			// Trigger the onRefresh callback via the FlatList props
			const onRefresh = flatList[0].props.refreshControl?.props?.onRefresh;
			expect(onRefresh).toBeDefined();
			onRefresh();

			expect(refetchMock).toHaveBeenCalled();
		} finally {
			// Restore original mock even if test throws
			trpcModule.trpc.photos.useQuery = originalUseQuery;
		}
	});
});

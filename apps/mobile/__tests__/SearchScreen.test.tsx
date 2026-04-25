import { fireEvent, waitFor } from "@testing-library/react-native";
import React from "react";

// tRPC mock — must go BEFORE the component import
jest.mock("@/lib/trpc", () => ({
	trpc: {
		searchPhotos: {
			useQuery: (
				input: { query: string; limit: number },
				opts: { enabled: boolean },
			) => {
				if (!opts.enabled || !input.query.trim()) {
					return { data: undefined, isFetching: false };
				}
				if (input.query === "xyznotfound") {
					return { data: { photos: [] }, isFetching: false };
				}
				return {
					data: { photos: require("./fixtures").SEARCH_RESULTS_PHOTOS },
					isFetching: false,
				};
			},
		},
	},
}));

import SearchScreen from "@/screens/SearchScreen";
import { renderWithProviders } from "./test-utils";

describe("SearchScreen", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("shows the search prompt when no query is entered", async () => {
		const { getByText } = renderWithProviders(<SearchScreen />);
		await waitFor(() => {
			expect(
				getByText("Search your photos using natural language"),
			).toBeTruthy();
		});
	});

	it("shows search input with placeholder", async () => {
		const { findByPlaceholderText } = renderWithProviders(<SearchScreen />);
		expect(
			await findByPlaceholderText("Search photos with AI..."),
		).toBeTruthy();
	});

	it("renders search results when a query is entered", async () => {
		const { findByPlaceholderText, getAllByTestId } = renderWithProviders(
			<SearchScreen />,
		);

		const input = await findByPlaceholderText("Search photos with AI...");
		fireEvent.changeText(input, "sunset beach");

		await waitFor(() => {
			const images = getAllByTestId("expo-image");
			expect(images.length).toBe(2);
		});
	});

	it("shows no results message for unmatched query", async () => {
		const { findByPlaceholderText, getByText } = renderWithProviders(
			<SearchScreen />,
		);

		const input = await findByPlaceholderText("Search photos with AI...");
		fireEvent.changeText(input, "xyznotfound");

		await waitFor(() => {
			expect(getByText("No results found")).toBeTruthy();
		});
	});

	it("clears the search input when clear button is pressed", async () => {
		const { findByPlaceholderText, getByTestId, getByText } =
			renderWithProviders(<SearchScreen />);

		const input = await findByPlaceholderText("Search photos with AI...");
		fireEvent.changeText(input, "sunset beach");

		await waitFor(() => {
			expect(getByTestId("icon-close-circle")).toBeTruthy();
		});

		fireEvent.press(getByTestId("icon-close-circle"));

		await waitFor(() => {
			expect(
				getByText("Search your photos using natural language"),
			).toBeTruthy();
		});
	});

	it("opens loupe view when a search result is tapped", async () => {
		const { findByPlaceholderText, getAllByTestId, getByText } =
			renderWithProviders(<SearchScreen />);

		const input = await findByPlaceholderText("Search photos with AI...");
		fireEvent.changeText(input, "sunset beach");

		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBe(2);
		});

		const images = getAllByTestId("expo-image");
		fireEvent.press(images[0]);

		await waitFor(() => {
			expect(getByText("Share")).toBeTruthy();
			expect(getByText("Like")).toBeTruthy();
			expect(getByText("Info")).toBeTruthy();
			expect(getByText("Delete")).toBeTruthy();
		});
	});

	it("shows correct photo data in loupe after tapping search result", async () => {
		const { findByPlaceholderText, getAllByTestId, getByText } =
			renderWithProviders(<SearchScreen />);

		const input = await findByPlaceholderText("Search photos with AI...");
		fireEvent.changeText(input, "sunset beach");

		await waitFor(() => {
			expect(getAllByTestId("expo-image").length).toBe(2);
		});

		const images = getAllByTestId("expo-image");
		fireEvent.press(images[0]);

		await waitFor(() => {
			expect(getByText(/6000 × 4000/)).toBeTruthy();
			expect(getByText(/4\.3 MB/)).toBeTruthy();
		});
	});
});

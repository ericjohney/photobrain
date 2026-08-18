import { fireEvent, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";

type SearchInput = { query: string; limit: number };
type SearchOptions = {
	enabled: boolean;
	trpc: { abortOnUnmount: boolean };
};

const mockSearchCancel = jest.fn();

const mockSearchUseQuery = jest.fn(
	(input: SearchInput, options: SearchOptions) => {
		if (!options.enabled || !input.query.trim()) {
			return {
				data: undefined,
				isFetching: false,
				isError: false,
				error: null,
				refetch: jest.fn(),
			};
		}
		if (input.query === "xyznotfound") {
			return {
				data: { photos: [] },
				isFetching: false,
				isError: false,
				error: null,
				refetch: jest.fn(),
			};
		}
		if (input.query === "offline") {
			return {
				data: undefined,
				isFetching: false,
				isError: true,
				error: new Error("Offline"),
				refetch: jest.fn(),
			};
		}
		if (input.query === "cached-error") {
			return {
				data: { photos: require("./fixtures").SEARCH_RESULTS_PHOTOS },
				isFetching: false,
				isError: true,
				error: new Error("Refetch failed"),
				refetch: jest.fn(),
			};
		}
		if (input.query === "cached-fetching") {
			return {
				data: { photos: require("./fixtures").SEARCH_RESULTS_PHOTOS },
				isFetching: true,
				isError: false,
				error: null,
				refetch: jest.fn(),
			};
		}
		return {
			data: { photos: require("./fixtures").SEARCH_RESULTS_PHOTOS },
			isFetching: false,
			isError: false,
			error: null,
			refetch: jest.fn(),
		};
	},
);

jest.mock("@/lib/trpc", () => ({
	trpc: {
		useUtils: () => ({ searchPhotos: { cancel: mockSearchCancel } }),
		searchPhotos: {
			useQuery: (input: SearchInput, options: SearchOptions) =>
				mockSearchUseQuery(input, options),
		},
	},
}));

import SearchScreen from "@/screens/SearchScreen";
import { renderWithProviders } from "./test-utils";

describe("SearchScreen", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("renders without requiring a React Navigation context", async () => {
		const { getByLabelText, getByText } = renderWithProviders(<SearchScreen />);

		await waitFor(() => expect(getByLabelText("Search photos")).toBeTruthy());
		expect(getByLabelText("Search photos").props.placeholder).toBe(
			"Search Photos",
		);
		expect(getByText("Search your library")).toBeTruthy();
		expect(getByText(/visual meaning/)).toBeTruthy();
	});

	it("debounces rapid input and requests only the final phrase", async () => {
		const { getByLabelText, getAllByTestId } = renderWithProviders(
			<SearchScreen />,
		);
		const input = await waitFor(() => getByLabelText("Search photos"));

		fireEvent.changeText(input, "sunset beach");
		fireEvent.changeText(input, "mountains in winter");

		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(2), {
			timeout: 1500,
		});
		const enabledQueries = mockSearchUseQuery.mock.calls.filter(
			([, options]) => options.enabled,
		);
		expect(
			enabledQueries.some(([input]) => input.query === "sunset beach"),
		).toBe(false);
		expect(
			enabledQueries.some(
				([input, options]) =>
					input.query === "mountains in winter" &&
					options.trpc.abortOnUnmount === true,
			),
		).toBe(true);
	});

	it("shows an empty state for an unmatched phrase", async () => {
		const { getByLabelText, getByText } = renderWithProviders(<SearchScreen />);
		const input = await waitFor(() => getByLabelText("Search photos"));

		fireEvent.changeText(input, "xyznotfound");
		await waitFor(() => expect(getByText("No results")).toBeTruthy(), {
			timeout: 1500,
		});
		expect(getByText(/broader description/)).toBeTruthy();
	});

	it("clears search from the native cancel action", async () => {
		const { getByLabelText, getByText } = renderWithProviders(<SearchScreen />);
		const input = await waitFor(() => getByLabelText("Search photos"));
		fireEvent.changeText(input, "sunset beach");
		await waitFor(() => expect(getByText("Searching...")).toBeTruthy());

		fireEvent(input, "cancelButtonPress", { nativeEvent: {} });
		await waitFor(() => expect(getByText("Search your library")).toBeTruthy());
		expect(mockSearchCancel).toHaveBeenCalled();
	});

	it("runs example searches", async () => {
		const { getAllByTestId, getByText } = renderWithProviders(<SearchScreen />);
		await waitFor(() => expect(getByText("red car")).toBeTruthy());

		fireEvent.press(getByText("red car"));
		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(2), {
			timeout: 1500,
		});
	});

	it("keeps cached results visible when a background refetch fails", async () => {
		const { getAllByTestId, getByLabelText, queryByText } = renderWithProviders(
			<SearchScreen />,
		);
		fireEvent.changeText(
			await waitFor(() => getByLabelText("Search photos")),
			"cached-error",
		);

		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(2), {
			timeout: 1500,
		});
		expect(queryByText("Search unavailable")).toBeNull();
	});

	it("keeps cached results visible during a background refetch", async () => {
		const { getAllByTestId, getByLabelText, queryByText } = renderWithProviders(
			<SearchScreen />,
		);
		fireEvent.changeText(
			await waitFor(() => getByLabelText("Search photos")),
			"cached-fetching",
		);

		await waitFor(() => expect(getAllByTestId("expo-image")).toHaveLength(2), {
			timeout: 1500,
		});
		expect(queryByText("Searching...")).toBeNull();
	});

	it("shows a blocking error when a search has no cached data", async () => {
		const { getByLabelText, getByText } = renderWithProviders(<SearchScreen />);
		fireEvent.changeText(
			await waitFor(() => getByLabelText("Search photos")),
			"offline",
		);

		await waitFor(() => expect(getByText("Search unavailable")).toBeTruthy(), {
			timeout: 1500,
		});
	});

	it("opens a result in the loupe with the correct metadata", async () => {
		const { getByLabelText, getByTestId, getByText, queryByTestId } =
			renderWithProviders(<SearchScreen />);
		const input = await waitFor(() => getByLabelText("Search photos"));
		fireEvent.changeText(input, "sunset beach");

		await waitFor(() => expect(getByTestId("search-result-1")).toBeTruthy(), {
			timeout: 1500,
		});
		fireEvent.press(getByTestId("search-result-1"));

		await waitFor(() => expect(getByTestId("loupe-view")).toBeTruthy());
		expect(getByTestId("loupe-gallery")).toBeTruthy();
		expect(Haptics.selectionAsync).not.toHaveBeenCalled();
		expect(getByText("Info")).toBeTruthy();
		expect(getByText(/6000 × 4000/)).toBeTruthy();
		expect(getByText(/4\.3 MB/)).toBeTruthy();
		fireEvent.press(getByLabelText("Close photo"));
		await waitFor(() => expect(queryByTestId("loupe-view")).toBeNull());
	});
});

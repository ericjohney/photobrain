import { fireEvent, waitFor } from "@testing-library/react-native";
import FilterSheet from "@/components/FilterSheet";
import { renderWithProviders } from "./test-utils";

const mockOnClose = jest.fn();
const mockOnFilterChange = jest.fn();
const mockOnGroupingChange = jest.fn();
const mockOnScan = jest.fn();
const mockOnOpenSettings = jest.fn();

const defaultProps = {
	visible: true,
	onClose: mockOnClose,
	filterOptions: {
		cameras: ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"],
		lenses: [
			"FE 24-70mm f/2.8 GM",
			"FE 85mm f/1.4 GM",
			"RF 15-35mm f/2.8L IS USM",
		],
		isos: [100, 200, 400, 800, 3200],
		dates: ["2024-06", "2024-07", "2024-08"],
	},
	activeFilters: {
		camera: null as string | null,
		lens: null as string | null,
		iso: null as number | null,
		dateMonth: null as string | null,
	},
	onFilterChange: mockOnFilterChange,
	grouping: "all" as const,
	onGroupingChange: mockOnGroupingChange,
	onScan: mockOnScan,
	onOpenSettings: mockOnOpenSettings,
};

beforeEach(() => {
	jest.clearAllMocks();
});

describe("FilterSheet", () => {
	it("distinguishes loading filters from an empty library", async () => {
		const { findByText, queryByText, getByLabelText } = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				filterOptions={undefined}
				isLoadingFilters
			/>,
		);
		await findByText("Loading filters...");
		expect(queryByText("No filter options available")).toBeNull();
		expect(getByLabelText("Open settings")).toBeTruthy();
	});

	it("offers retry when filters fail without hiding library actions", async () => {
		const retry = jest.fn();
		const { findByText, getByLabelText } = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				filterOptions={undefined}
				filtersError
				onRetryFilters={retry}
			/>,
		);
		await findByText("Couldn't load filters");
		fireEvent.press(getByLabelText("Retry filters"));
		expect(retry).toHaveBeenCalledTimes(1);
		fireEvent.press(getByLabelText("Scan library"));
		expect(mockOnScan).toHaveBeenCalled();
	});

	it("keeps cached filter options available after a refetch error", async () => {
		const { findByText, queryByText } = renderWithProviders(
			<FilterSheet {...defaultProps} filtersError />,
		);
		await findByText("Sony A7III");
		expect(queryByText("Couldn't load filters")).toBeNull();
	});

	it("changes the library grouping", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => expect(getByText("All Photos")).toBeTruthy());

		fireEvent.press(getByText("Months"));
		expect(mockOnGroupingChange).toHaveBeenCalledWith("months");
	});

	it("exposes scan and settings actions", async () => {
		const { getByLabelText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => expect(getByLabelText("Scan library")).toBeTruthy());

		fireEvent.press(getByLabelText("Scan library"));
		fireEvent.press(getByLabelText("Open settings"));
		expect(mockOnScan).toHaveBeenCalledTimes(1);
		expect(mockOnOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("renders camera options", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => {
			expect(getByText("Sony A7III")).toBeTruthy();
			expect(getByText("Canon EOS R5")).toBeTruthy();
			expect(getByText("Fujifilm X-T5")).toBeTruthy();
		});
	});

	it("renders ISO options", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => {
			expect(getByText("ISO 100")).toBeTruthy();
			expect(getByText("ISO 3200")).toBeTruthy();
		});
	});

	it("renders formatted date options", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => {
			expect(getByText("June 2024")).toBeTruthy();
			expect(getByText("July 2024")).toBeTruthy();
			expect(getByText("August 2024")).toBeTruthy();
		});
	});

	it("calls onFilterChange when camera option is tapped", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => {
			expect(getByText("Sony A7III")).toBeTruthy();
		});
		fireEvent.press(getByText("Sony A7III"));
		expect(mockOnFilterChange).toHaveBeenCalledWith({
			camera: "Sony A7III",
			lens: null,
			iso: null,
			dateMonth: null,
		});
	});

	it("deselects when tapping active filter", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				activeFilters={{ ...defaultProps.activeFilters, camera: "Sony A7III" }}
			/>,
		);
		await waitFor(() => {
			expect(getByText("Sony A7III")).toBeTruthy();
		});
		fireEvent.press(getByText("Sony A7III"));
		expect(mockOnFilterChange).toHaveBeenCalledWith({
			camera: null,
			lens: null,
			iso: null,
			dateMonth: null,
		});
	});

	it("calls onClose when Done is pressed", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet {...defaultProps} />,
		);
		await waitFor(() => {
			expect(getByText("Done")).toBeTruthy();
		});
		fireEvent.press(getByText("Done"));
		expect(mockOnClose).toHaveBeenCalled();
	});

	it("clears all filters when Clear All is pressed", async () => {
		const { getByText } = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				activeFilters={{
					camera: "Sony A7III",
					lens: "FE 24-70mm f/2.8 GM",
					iso: 100,
					dateMonth: "2024-06",
				}}
			/>,
		);
		await waitFor(() => {
			expect(getByText("Clear All")).toBeTruthy();
		});
		fireEvent.press(getByText("Clear All"));
		expect(mockOnFilterChange).toHaveBeenCalledWith({
			camera: null,
			lens: null,
			iso: null,
			dateMonth: null,
		});
	});
});

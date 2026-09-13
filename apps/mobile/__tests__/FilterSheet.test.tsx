import { fireEvent } from "@testing-library/react-native";
import { useState } from "react";
import * as ReactNative from "react-native";
import { FlatList, Modal, ScrollView } from "react-native";
import FilterSheet, {
	EMPTY_FILTERS,
	formatDateMonth,
	type LibraryFilters,
} from "@/components/FilterSheet";
import { renderWithProviders } from "./test-utils";

const mockOnClose = jest.fn();
const mockOnFilterChange = jest.fn();
const mockOnGroupingChange = jest.fn();
const mockOnSortChange = jest.fn();
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
	activeFilters: EMPTY_FILTERS,
	onFilterChange: mockOnFilterChange,
	grouping: "all" as const,
	onGroupingChange: mockOnGroupingChange,
	sort: "captured" as const,
	onSortChange: mockOnSortChange,
	onScan: mockOnScan,
	onOpenSettings: mockOnOpenSettings,
};
const combinedFilters: LibraryFilters = {
	camera: "Sony A7III",
	lens: "FE 24-70mm f/2.8 GM",
	iso: 100,
	dateMonth: "2024-06",
	filterRaw: "raw",
};

function ControlledSheet({
	initialFilters = EMPTY_FILTERS,
}: {
	initialFilters?: LibraryFilters;
}) {
	const [filters, setFilters] = useState(initialFilters);
	return (
		<FilterSheet
			{...defaultProps}
			initialPage="filters"
			activeFilters={filters}
			onFilterChange={(next) => {
				setFilters(next);
				mockOnFilterChange(next);
			}}
		/>
	);
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe("FilterSheet", () => {
	it("stacks large-type labels and respects landscape and bottom safe areas", async () => {
		jest
			.spyOn(ReactNative, "useWindowDimensions")
			.mockReturnValue({ width: 568, height: 320, scale: 2, fontScale: 2 });
		jest
			.spyOn(
				jest.requireMock("react-native-safe-area-context"),
				"useSafeAreaInsets",
			)
			.mockReturnValue({ top: 0, bottom: 21, left: 44, right: 44 });
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				initialPage="filters"
				activeFilters={combinedFilters}
			/>,
		);
		const heading = await ui.findByRole("header", { name: "Filter" });
		expect(heading.props.numberOfLines).toBeUndefined();
		expect(ui.getByRole("button", { name: "Done" })).toBeEnabled();
		expect(
			ReactNative.StyleSheet.flatten(
				ui.getByTestId("filter-sheet").props.style,
			),
		).toMatchObject({ paddingLeft: 44, paddingRight: 44 });
		expect(
			ReactNative.StyleSheet.flatten(
				ui.UNSAFE_getByType(ScrollView).props.contentContainerStyle,
			),
		).toMatchObject({ paddingBottom: 45 });
		expect(ui.getByText("Sony A7III")).toHaveStyle({
			textAlign: "left",
			marginLeft: 0,
		});
		fireEvent.press(ui.getByRole("button", { name: "Camera" }));
		expect(
			ui.UNSAFE_getByType(FlatList).props.automaticallyAdjustKeyboardInsets,
		).toBe(true);
		expect(
			ReactNative.StyleSheet.flatten(
				ui.UNSAFE_getByType(FlatList).props.contentContainerStyle,
			),
		).toMatchObject({ paddingBottom: 45 });
	});

	it("separates sort, Filter, View Options, and library actions", async () => {
		const ui = renderWithProviders(<FilterSheet {...defaultProps} />);
		await ui.findByText("Library Options");
		expect(ui.getByText("Sort By")).toBeTruthy();
		expect(ui.getByText("View Options")).toBeTruthy();
		expect(ui.getByRole("button", { name: "Filter" })).toHaveAccessibilityValue(
			{ text: "All Items" },
		);
		expect(ui.queryByText("Camera")).toBeNull();
		expect(ui.queryByText("RAW")).toBeNull();
		expect(ui.UNSAFE_getByType(Modal).props.presentationStyle).toBe(
			"pageSheet",
		);
		fireEvent.press(ui.getByRole("button", { name: "Filter" }));
		expect(ui.getByRole("header", { name: "Filter" })).toBeTruthy();
		expect(ui.queryByText("Sort By")).toBeNull();
		expect(ui.queryByText("Sony A7III")).toBeNull();
	});

	it("shows a combined summary and selected category summaries", async () => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} activeFilters={combinedFilters} />,
		);
		const filter = await ui.findByRole("button", { name: "Filter" });
		expect(filter).toHaveAccessibilityValue({
			text: "RAW, Sony A7III, FE 24-70mm f/2.8 GM, ISO 100, June 2024",
		});
		fireEvent.press(filter);
		expect(ui.getByRole("button", { name: "Date" })).toHaveAccessibilityValue({
			text: "June 2024",
		});
		expect(ui.getByRole("radio", { name: "RAW" })).toBeChecked();
		expect(ui.getByRole("radio", { name: "All Items" })).not.toBeChecked();
	});

	it("combines metadata and media filters immediately without dismissing", async () => {
		const ui = renderWithProviders(<ControlledSheet />);
		fireEvent.press(await ui.findByRole("radio", { name: "RAW" }));
		for (const [category, label] of [
			["Camera", "Sony A7III"],
			["Lens", "FE 24-70mm f/2.8 GM"],
			["ISO", "ISO 100"],
			["Date", "June 2024"],
		]) {
			fireEvent.press(ui.getByRole("button", { name: category }));
			fireEvent.press(ui.getByRole("radio", { name: label }));
			expect(ui.getByRole("radio", { name: label })).toBeChecked();
			fireEvent.press(ui.getByRole("button", { name: "Back to Filter" }));
		}
		expect(mockOnFilterChange).toHaveBeenLastCalledWith(combinedFilters);
		expect(mockOnClose).not.toHaveBeenCalled();
	});

	it("makes RAW and Standard exclusive and clears a tapped selected media type", async () => {
		const ui = renderWithProviders(
			<ControlledSheet initialFilters={combinedFilters} />,
		);
		fireEvent.press(await ui.findByRole("radio", { name: "Standard" }));
		expect(ui.getByRole("radio", { name: "RAW" })).not.toBeChecked();
		expect(ui.getByRole("radio", { name: "Standard" })).toBeChecked();
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			filterRaw: "standard",
		});
		fireEvent.press(ui.getByRole("radio", { name: "Standard" }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			filterRaw: null,
		});
		fireEvent.press(ui.getByRole("radio", { name: "RAW" }));
		fireEvent.press(ui.getByRole("radio", { name: "RAW" }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			filterRaw: null,
		});
	});

	it.each([
		["Camera", "camera"],
		["Lens", "lens"],
		["ISO", "iso"],
		["Date", "dateMonth"],
	])("All in %s resets only that field", async (label, field) => {
		const ui = renderWithProviders(
			<ControlledSheet initialFilters={combinedFilters} />,
		);
		fireEvent.press(await ui.findByRole("button", { name: label }));
		fireEvent.press(ui.getByRole("radio", { name: `All ${label}` }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			[field]: null,
		});
		expect(ui.getByRole("radio", { name: `All ${label}` })).toBeChecked();
	});

	it.each([
		"All Items",
		"Clear all filters",
	])("%s resets every filter, including RAW", async (label) => {
		const ui = renderWithProviders(
			<ControlledSheet initialFilters={combinedFilters} />,
		);
		fireEvent.press(await ui.findByLabelText(label));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
		expect(ui.getByRole("radio", { name: "All Items" })).toBeChecked();
		expect(
			ui.getByRole("button", { name: "Clear all filters" }),
		).toBeDisabled();
		expect(mockOnClose).not.toHaveBeenCalled();
	});

	it.each([
		["Camera", "  sOnY ", "Sony A7III", "Canon EOS R5"],
		["Lens", "85mm", "FE 85mm f/1.4 GM", "FE 24-70mm f/2.8 GM"],
		["ISO", "3200", "ISO 3200", "ISO 100"],
		["Date", "july 2024", "July 2024", "June 2024"],
		["Date", "2024-07", "July 2024", "June 2024"],
	])("searches %s options using %s", async (category, query, match, excluded) => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} initialPage="filters" />,
		);
		fireEvent.press(await ui.findByRole("button", { name: category }));
		expect(ui.UNSAFE_getByType(FlatList)).toBeTruthy();
		fireEvent.changeText(ui.getByLabelText(`Search ${category}`), query);
		expect(ui.getByRole("radio", { name: match })).toBeTruthy();
		expect(ui.queryByRole("radio", { name: excluded })).toBeNull();
		fireEvent.changeText(
			ui.getByLabelText(`Search ${category}`),
			"no such option",
		);
		expect(ui.getByText("No matching options")).toBeTruthy();
		expect(ui.getByRole("radio", { name: `All ${category}` })).toBeTruthy();
	});

	it("keeps selected unavailable values removable even without metadata", async () => {
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				initialPage="filters"
				filterOptions={undefined}
				filtersError
				activeFilters={combinedFilters}
			/>,
		);
		fireEvent.press(await ui.findByRole("button", { name: "Camera" }));
		expect(ui.getByRole("radio", { name: "Sony A7III" })).toBeChecked();
		fireEvent.press(ui.getByRole("radio", { name: "Sony A7III" }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			camera: null,
		});
		fireEvent.changeText(ui.getByLabelText("Search Camera"), "missing");
		fireEvent.press(ui.getByRole("radio", { name: "All Camera" }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith({
			...combinedFilters,
			camera: null,
		});
	});

	it("Back navigates without dismissing or applying; Done only dismisses", async () => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} initialPage="filters" />,
		);
		fireEvent.press(await ui.findByRole("button", { name: "Camera" }));
		fireEvent.changeText(ui.getByLabelText("Search Camera"), "sony");
		fireEvent.press(ui.getByRole("button", { name: "Back to Filter" }));
		fireEvent.press(ui.getByRole("button", { name: "Lens" }));
		expect(ui.getByLabelText("Search Lens")).toHaveDisplayValue("");
		fireEvent.press(ui.getByRole("button", { name: "Back to Filter" }));
		fireEvent.press(
			ui.getByRole("button", { name: "Back to Library Options" }),
		);
		expect(ui.getByRole("header", { name: "Library Options" })).toBeTruthy();
		expect(mockOnClose).not.toHaveBeenCalled();
		fireEvent.press(ui.getByRole("button", { name: "Done" }));
		expect(mockOnClose).toHaveBeenCalledTimes(1);
		expect(mockOnFilterChange).not.toHaveBeenCalled();
		expect(ui.queryByLabelText("Apply filters")).toBeNull();
	});

	it("Done and native dismissal close a drill-down without changing filters", async () => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} initialPage="filters" />,
		);
		fireEvent.press(await ui.findByRole("button", { name: "Date" }));
		fireEvent.press(ui.getByRole("button", { name: "Done" }));
		fireEvent(ui.UNSAFE_getByType(Modal), "requestClose");
		expect(mockOnClose).toHaveBeenCalledTimes(2);
		expect(mockOnFilterChange).not.toHaveBeenCalled();
	});

	it.each([
		"options",
		"filters",
	] as const)("reopening resets navigation and search to initialPage %s", async (initialPage) => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} initialPage={initialPage} />,
		);
		await ui.findByRole("button", { name: "Done" });
		if (initialPage === "options")
			fireEvent.press(ui.getByRole("button", { name: "Filter" }));
		fireEvent.press(ui.getByRole("button", { name: "Camera" }));
		fireEvent.changeText(ui.getByLabelText("Search Camera"), "sony");
		ui.rerender(
			<FilterSheet
				{...defaultProps}
				initialPage={initialPage}
				visible={false}
			/>,
		);
		ui.rerender(
			<FilterSheet {...defaultProps} initialPage={initialPage} visible />,
		);
		expect(
			ui.getByRole("header", {
				name: initialPage === "options" ? "Library Options" : "Filter",
			}),
		).toBeTruthy();
		if (initialPage === "options")
			fireEvent.press(ui.getByRole("button", { name: "Filter" }));
		fireEvent.press(ui.getByRole("button", { name: "Camera" }));
		expect(ui.getByLabelText("Search Camera")).toHaveDisplayValue("");
		expect(ui.getByRole("radio", { name: "Canon EOS R5" })).toBeTruthy();
	});

	it("distinguishes loading from empty metadata while retaining resets and media choices", async () => {
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				initialPage="filters"
				filterOptions={undefined}
				isLoadingFilters
				activeFilters={combinedFilters}
			/>,
		);
		await ui.findByText("Loading filters...");
		expect(ui.queryByText("No filter options available")).toBeNull();
		fireEvent.press(ui.getByRole("radio", { name: "Standard" }));
		expect(mockOnFilterChange).toHaveBeenCalledWith({
			...combinedFilters,
			filterRaw: "standard",
		});
		fireEvent.press(ui.getByRole("button", { name: "Clear all filters" }));
		expect(mockOnFilterChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
		fireEvent.press(ui.getByRole("button", { name: "Camera" }));
		expect(ui.getByText("Loading filters...")).toBeTruthy();
	});

	it("offers retry after failure and keeps library actions reachable", async () => {
		const retry = jest.fn();
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				initialPage="filters"
				filterOptions={undefined}
				filtersError
				onRetryFilters={retry}
			/>,
		);
		await ui.findByText("Couldn't load filters");
		expect(ui.queryByText("No filter options available")).toBeNull();
		fireEvent.press(ui.getByLabelText("Retry filters"));
		expect(retry).toHaveBeenCalledTimes(1);
		fireEvent.press(ui.getByRole("button", { name: "Camera" }));
		fireEvent.press(ui.getByLabelText("Retry filters"));
		expect(retry).toHaveBeenCalledTimes(2);
		fireEvent.press(ui.getByLabelText("Back to Filter"));
		fireEvent.press(ui.getByLabelText("Back to Library Options"));
		fireEvent.press(ui.getByLabelText("Scan library"));
		fireEvent.press(ui.getByLabelText("Open settings"));
		expect(mockOnScan).toHaveBeenCalledTimes(1);
		expect(mockOnOpenSettings).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ filtersError: true },
		{ isLoadingFilters: true },
	])("keeps cached metadata usable during %j", async (state) => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} {...state} initialPage="filters" />,
		);
		fireEvent.press(await ui.findByRole("button", { name: "Camera" }));
		expect(ui.queryByText("Couldn't load filters")).toBeNull();
		expect(ui.queryByText("Loading filters...")).toBeNull();
		fireEvent.press(ui.getByRole("radio", { name: "Sony A7III" }));
		expect(mockOnFilterChange).toHaveBeenCalledWith({
			...EMPTY_FILTERS,
			camera: "Sony A7III",
		});
	});

	it("shows empty metadata without disabling media filters or category resets", async () => {
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				initialPage="filters"
				filterOptions={{ cameras: [], lenses: [], isos: [], dates: [] }}
			/>,
		);
		await ui.findByText("No filter options available");
		expect(ui.getByRole("radio", { name: "RAW" })).toBeEnabled();
		fireEvent.press(ui.getByRole("button", { name: "Date" }));
		expect(ui.getByText("No filter options available")).toBeTruthy();
		expect(ui.getByRole("radio", { name: "All Date" })).toBeEnabled();
	});

	it.each([
		{ scanDisabled: true },
		{ isScanning: true },
	])("prevents scanning when %j", async (state) => {
		const ui = renderWithProviders(
			<FilterSheet {...defaultProps} {...state} />,
		);
		const scan = await ui.findByLabelText("Scan library");
		expect(scan).toBeDisabled();
		fireEvent.press(scan);
		expect(mockOnScan).not.toHaveBeenCalled();
		expect(ui.getByLabelText("Open settings")).toBeEnabled();
	});

	it("shows checkmarked sort/grouping choices and changes them independently", async () => {
		const ui = renderWithProviders(<FilterSheet {...defaultProps} />);
		expect(
			await ui.findByRole("radio", { name: "Date Captured" }),
		).toBeChecked();
		expect(ui.getByRole("radio", { name: "All Photos" })).toBeChecked();
		fireEvent.press(ui.getByRole("radio", { name: "Recently Added" }));
		fireEvent.press(ui.getByRole("radio", { name: "Months" }));
		expect(mockOnSortChange).toHaveBeenCalledWith("added");
		expect(mockOnGroupingChange).toHaveBeenCalledWith("months");
		ui.rerender(
			<FilterSheet {...defaultProps} sort="added" grouping="months" />,
		);
		expect(ui.getByRole("radio", { name: "Recently Added" })).toBeChecked();
		expect(ui.getByRole("radio", { name: "Months" })).toBeChecked();
		expect(ui.getByRole("radio", { name: "Date Captured" })).not.toBeChecked();
		fireEvent.press(ui.getByRole("radio", { name: "Date Captured" }));
		fireEvent.press(ui.getByRole("radio", { name: "Years" }));
		expect(mockOnSortChange).toHaveBeenLastCalledWith("captured");
		expect(mockOnGroupingChange).toHaveBeenLastCalledWith("years");
		expect(mockOnFilterChange).not.toHaveBeenCalled();
		expect(mockOnClose).not.toHaveBeenCalled();
	});

	it("does not offer unimplemented optional actions", async () => {
		const ui = renderWithProviders(
			<FilterSheet
				{...defaultProps}
				onSortChange={undefined}
				onGroupingChange={undefined}
				onScan={undefined}
				onOpenSettings={undefined}
			/>,
		);
		await ui.findByText("Library Options");
		expect(ui.queryByText("Sort By")).toBeNull();
		expect(ui.queryByText("View Options")).toBeNull();
		expect(ui.queryByLabelText("Scan library")).toBeNull();
		expect(ui.queryByLabelText("Open settings")).toBeNull();
	});
});

describe("formatDateMonth", () => {
	it.each([
		["2024-06", "June 2024"],
		["2024:12", "December 2024"],
		["2024-00", "2024-00"],
		["2024-13", "2024-13"],
		["2024-ab", "2024-ab"],
		["invalid", "invalid"],
	])("formats %s safely", (value, expected) => {
		expect(formatDateMonth(value)).toBe(expected);
	});
});

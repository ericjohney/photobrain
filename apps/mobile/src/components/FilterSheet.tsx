import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { type ComponentProps, type ReactNode, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/theme";

export type LibraryGrouping = "years" | "months" | "all";
export type LibrarySort = "captured" | "added";
export interface LibraryFilters {
	camera: string | null;
	lens: string | null;
	iso: number | null;
	dateMonth: string | null;
	filterRaw: "raw" | "standard" | null;
}

export const EMPTY_FILTERS: LibraryFilters = {
	camera: null,
	lens: null,
	iso: null,
	dateMonth: null,
	filterRaw: null,
};

interface FilterSheetProps {
	visible: boolean;
	onClose: () => void;
	filterOptions?: inferRouterOutputs<AppRouter>["filterOptions"];
	activeFilters: LibraryFilters;
	onFilterChange: (filters: LibraryFilters) => void;
	sort?: LibrarySort;
	onSortChange?: (sort: LibrarySort) => void;
	initialPage?: "options" | "filters";
	onScan?: () => void;
	scanDisabled?: boolean;
	isScanning?: boolean;
	onOpenSettings?: () => void;
	isLoadingFilters?: boolean;
	filtersError?: boolean;
	onRetryFilters?: () => void;
}

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
	{ value: "added", label: "Recently Added" },
	{ value: "captured", label: "Date Captured" },
];

const CATEGORIES = [
	{ field: "camera", options: "cameras", label: "Camera" },
	{ field: "lens", options: "lenses", label: "Lens" },
	{ field: "iso", options: "isos", label: "ISO" },
	{ field: "dateMonth", options: "dates", label: "Date" },
] as const;
type Category = (typeof CATEGORIES)[number]["field"];
type Page = "options" | "filters" | Category;

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export function formatDateMonth(value: string): string {
	const match = /^(\d{4})[-:](\d{2})$/.exec(value);
	if (!match) return value;
	const month = Number(match[2]);
	return month >= 1 && month <= 12
		? `${MONTH_NAMES[month - 1]} ${match[1]}`
		: value;
}

export default function FilterSheet({
	visible,
	onClose,
	filterOptions,
	activeFilters,
	onFilterChange,
	sort = "captured",
	onSortChange,
	initialPage = "options",
	onScan,
	scanDisabled = false,
	isScanning = false,
	onOpenSettings,
	isLoadingFilters = false,
	filtersError = false,
	onRetryFilters,
}: FilterSheetProps) {
	const colors = useColors();
	const insets = useSafeAreaInsets();
	const { fontScale } = useWindowDimensions();
	const largeType = fontScale > 1.3;
	const [page, setPage] = useState<Page>(initialPage);
	const [search, setSearch] = useState("");
	const [wasVisible, setWasVisible] = useState(visible);

	// Reset before rendering a reopened sheet, including when it stays mounted.
	if (visible !== wasVisible) {
		setWasVisible(visible);
		if (visible) {
			setPage(initialPage);
			setSearch("");
		}
	}

	const navigate = (destination: Page) => {
		setSearch("");
		setPage(destination);
	};
	const category = CATEGORIES.find(({ field }) => field === page);
	const title =
		category?.label ?? (page === "filters" ? "Filter" : "Library Options");
	const goBack = () => navigate(category ? "filters" : "options");
	const hasActiveFilters = Object.values(activeFilters).some(
		(value) => value !== null,
	);
	const clearAll = () => onFilterChange({ ...EMPTY_FILTERS });
	const formatValue = (field: Category, value: string | number | null) => {
		if (value === null) return "All";
		if (field === "dateMonth") return formatDateMonth(String(value));
		return field === "iso" ? `ISO ${value}` : String(value);
	};
	const summary =
		[
			activeFilters.filterRaw === "raw"
				? "RAW"
				: activeFilters.filterRaw === "standard"
					? "Standard"
					: null,
			...CATEGORIES.map(({ field }) =>
				activeFilters[field] === null
					? null
					: formatValue(field, activeFilters[field]),
			),
		]
			.filter(Boolean)
			.join(", ") || "All Items";

	const row = ({
		label,
		onPress,
		checked,
		detail,
		icon,
		disclosure = false,
		disabled = false,
		busy = false,
		stacked = false,
		accessibilityLabel = label,
		last = false,
	}: {
		label: string;
		onPress: () => void;
		checked?: boolean;
		detail?: string;
		icon?: ComponentProps<typeof Ionicons>["name"];
		disclosure?: boolean;
		disabled?: boolean;
		busy?: boolean;
		stacked?: boolean;
		accessibilityLabel?: string;
		last?: boolean;
	}) => (
		<Pressable
			key={label}
			accessibilityRole={checked === undefined ? "button" : "radio"}
			accessibilityLabel={accessibilityLabel}
			accessibilityValue={detail ? { text: detail } : undefined}
			accessibilityState={{ checked, disabled, busy }}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => [
				styles.row,
				{ backgroundColor: pressed ? colors.accent : colors.card },
			]}
		>
			{icon && (
				<Ionicons
					name={icon}
					size={22}
					color={disabled ? colors.mutedForeground : colors.primary}
					accessible={false}
				/>
			)}
			<View
				style={[
					styles.rowContent,
					!last && {
						borderBottomColor: colors.border,
						borderBottomWidth: StyleSheet.hairlineWidth,
					},
				]}
			>
				<View
					style={[
						styles.rowLabels,
						(largeType || stacked) && styles.stackedLabels,
					]}
				>
					<Text
						style={[
							styles.rowText,
							{ color: disabled ? colors.mutedForeground : colors.foreground },
						]}
					>
						{label}
					</Text>
					{detail && (
						<Text
							style={[
								styles.detail,
								{ color: colors.mutedForeground },
								(largeType || stacked) && styles.stackedDetail,
							]}
						>
							{detail}
						</Text>
					)}
				</View>
				{busy ? (
					<ActivityIndicator color={colors.primary} />
				) : checked ? (
					<Ionicons
						name="checkmark"
						size={22}
						color={colors.primary}
						accessible={false}
					/>
				) : disclosure ? (
					<Ionicons
						name="chevron-forward"
						size={17}
						color={colors.mutedForeground}
						accessible={false}
					/>
				) : (
					<View style={styles.checkSpace} />
				)}
			</View>
		</Pressable>
	);
	const group = (heading: string | null, children: ReactNode) => (
		<View style={styles.section}>
			{heading && (
				<Text
					accessibilityRole="header"
					style={[styles.sectionTitle, { color: colors.mutedForeground }]}
				>
					{heading}
				</Text>
			)}
			<View style={styles.group}>{children}</View>
		</View>
	);
	const message = (text: string) => (
		<Text style={[styles.message, { color: colors.mutedForeground }]}>
			{text}
		</Text>
	);
	const metadataStatus =
		!filterOptions && (isLoadingFilters || filtersError) ? (
			<View style={styles.status} accessibilityLiveRegion="polite">
				{isLoadingFilters && <ActivityIndicator color={colors.primary} />}
				{message(
					isLoadingFilters ? "Loading filters..." : "Couldn't load filters",
				)}
				{!isLoadingFilters && onRetryFilters && (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Retry filters"
						onPress={onRetryFilters}
						style={styles.headerAction}
					>
						<Text style={[styles.actionText, { color: colors.primary }]}>
							Try Again
						</Text>
					</Pressable>
				)}
			</View>
		) : null;
	const availableValues: Array<string | number> = category
		? (filterOptions?.[category.options] ?? [])
		: [];
	const selectedValue = category ? activeFilters[category.field] : null;
	// A saved selection may disappear from refreshed metadata; keep it removable.
	const values =
		selectedValue !== null && !availableValues.includes(selectedValue)
			? [selectedValue, ...availableValues]
			: availableValues;
	const query = search.trim().toLocaleLowerCase();
	const matchingValues = category
		? values.filter((value) =>
				`${formatValue(category.field, value)} ${value}`
					.toLocaleLowerCase()
					.includes(query),
			)
		: [];
	const contentPadding = { paddingBottom: insets.bottom + 24 };
	const headerTitle = (
		<Text
			accessibilityRole="header"
			style={[styles.headerTitle, { color: colors.foreground }]}
		>
			{title}
		</Text>
	);

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<View
				testID="filter-sheet"
				style={[
					styles.container,
					{
						backgroundColor: colors.background,
						paddingLeft: insets.left,
						paddingRight: insets.right,
					},
				]}
			>
				<View
					style={[
						styles.header,
						{
							paddingTop: Math.max(insets.top, 12),
							borderBottomColor: colors.border,
						},
					]}
				>
					<View style={styles.headerBar}>
						<View style={!largeType && styles.headerSide}>
							{page !== "options" && (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={
										category ? "Back to Filter" : "Back to Library Options"
									}
									onPress={goBack}
									style={styles.headerAction}
								>
									<Ionicons
										name="chevron-back"
										size={24}
										color={colors.primary}
										accessible={false}
									/>
								</Pressable>
							)}
						</View>
						{!largeType && headerTitle}
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Done"
							onPress={onClose}
							style={[styles.headerAction, !largeType && styles.headerSide]}
						>
							<Text style={[styles.actionText, { color: colors.primary }]}>
								Done
							</Text>
						</Pressable>
					</View>
					{largeType && headerTitle}
				</View>

				{category ? (
					<FlatList
						key={category.field}
						style={styles.container}
						contentContainerStyle={[styles.content, contentPadding]}
						data={matchingValues}
						extraData={activeFilters}
						keyExtractor={(value) => String(value)}
						keyboardShouldPersistTaps="handled"
						keyboardDismissMode="on-drag"
						automaticallyAdjustKeyboardInsets
						ListHeaderComponent={
							<>
								<View style={[styles.search, { backgroundColor: colors.card }]}>
									<Ionicons
										name="search"
										size={20}
										color={colors.mutedForeground}
										accessible={false}
									/>
									<TextInput
										accessibilityLabel={`Search ${category.label}`}
										placeholder={`Search ${category.label}`}
										placeholderTextColor={colors.mutedForeground}
										value={search}
										onChangeText={setSearch}
										autoCapitalize="none"
										autoCorrect={false}
										clearButtonMode="while-editing"
										returnKeyType="search"
										style={[styles.searchInput, { color: colors.foreground }]}
									/>
								</View>
								{group(
									null,
									row({
										label: "All",
										accessibilityLabel: `All ${category.label}`,
										checked: selectedValue === null,
										onPress: () =>
											onFilterChange({
												...activeFilters,
												[category.field]: null,
											}),
										last: true,
									}),
								)}
								{metadataStatus}
								<View style={styles.listGap} />
							</>
						}
						renderItem={({ item, index }) => (
							<View
								style={[
									index === 0 && styles.firstOption,
									index === matchingValues.length - 1 && styles.lastOption,
								]}
							>
								{row({
									label: formatValue(category.field, item),
									checked: selectedValue === item,
									onPress: () =>
										onFilterChange({
											...activeFilters,
											[category.field]: selectedValue === item ? null : item,
										}),
									last: index === matchingValues.length - 1,
								})}
							</View>
						)}
						ListEmptyComponent={
							query
								? message("No matching options")
								: !metadataStatus
									? message("No filter options available")
									: null
						}
					/>
				) : (
					<ScrollView
						key={page}
						style={styles.container}
						contentContainerStyle={[styles.content, contentPadding]}
					>
						{page === "options" ? (
							<>
								{onSortChange &&
									group(
										"Sort By",
										SORT_OPTIONS.map((option, index) =>
											row({
												label: option.label,
												checked: sort === option.value,
												onPress: () => onSortChange(option.value),
												last: index === SORT_OPTIONS.length - 1,
											}),
										),
									)}
								{group(
									null,
									row({
										label: "Filter",
										detail: summary,
										stacked: true,
										icon: "funnel-outline",
										disclosure: true,
										onPress: () => navigate("filters"),
										last: true,
									}),
								)}
								{(onScan || onOpenSettings) &&
									group(
										"Library",
										<>
											{onScan &&
												row({
													label: "Scan Library",
													accessibilityLabel: "Scan library",
													icon: "sync-outline",
													onPress: onScan,
													disabled: scanDisabled || isScanning,
													busy: isScanning,
													last: !onOpenSettings,
												})}
											{onOpenSettings &&
												row({
													label: "Settings",
													accessibilityLabel: "Open settings",
													icon: "settings-outline",
													disclosure: true,
													onPress: onOpenSettings,
													last: true,
												})}
										</>,
									)}
							</>
						) : (
							<>
								{group(
									null,
									row({
										label: "All Items",
										checked: !hasActiveFilters,
										onPress: clearAll,
										last: true,
									}),
								)}
								{group(
									"Media Type",
									<>
										{row({
											label: "RAW",
											checked: activeFilters.filterRaw === "raw",
											onPress: () =>
												onFilterChange({
													...activeFilters,
													filterRaw:
														activeFilters.filterRaw === "raw" ? null : "raw",
												}),
										})}
										{row({
											label: "Standard",
											checked: activeFilters.filterRaw === "standard",
											onPress: () =>
												onFilterChange({
													...activeFilters,
													filterRaw:
														activeFilters.filterRaw === "standard"
															? null
															: "standard",
												}),
											last: true,
										})}
									</>,
								)}
								{group(
									"Metadata",
									CATEGORIES.map(({ field, label }, index) =>
										row({
											label,
											detail: formatValue(field, activeFilters[field]),
											disclosure: true,
											onPress: () => navigate(field),
											last: index === CATEGORIES.length - 1,
										}),
									),
								)}
								{metadataStatus}
								{!metadataStatus &&
									(!filterOptions ||
										CATEGORIES.every(
											({ options }) => filterOptions[options].length === 0,
										)) &&
									message("No filter options available")}
								{message(
									"Combine filters to narrow your library. Changes appear immediately.",
								)}
								{group(
									null,
									row({
										label: "Clear All",
										accessibilityLabel: "Clear all filters",
										disabled: !hasActiveFilters,
										onPress: clearAll,
										last: true,
									}),
								)}
							</>
						)}
					</ScrollView>
				)}
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	header: {
		paddingHorizontal: 12,
		paddingBottom: 10,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	headerBar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	headerSide: { width: 72 },
	headerAction: {
		minHeight: 44,
		minWidth: 44,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 8,
	},
	headerTitle: {
		flexShrink: 1,
		flexGrow: 1,
		textAlign: "center",
		fontSize: 17,
		fontWeight: "600",
		paddingVertical: 8,
	},
	actionText: { fontSize: 17, fontWeight: "600" },
	content: { paddingHorizontal: 20 },
	section: { marginTop: 24 },
	sectionTitle: { fontSize: 13, paddingHorizontal: 16, marginBottom: 8 },
	group: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
	row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, gap: 12 },
	rowContent: {
		flex: 1,
		minHeight: 52,
		flexDirection: "row",
		alignItems: "center",
		paddingVertical: 13,
		paddingRight: 16,
		gap: 12,
	},
	rowLabels: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
	stackedLabels: { flexDirection: "column", alignItems: "stretch", gap: 4 },
	rowText: { flexShrink: 1, fontSize: 17 },
	detail: {
		flexShrink: 1,
		fontSize: 15,
		marginLeft: "auto",
		textAlign: "right",
	},
	stackedDetail: { marginLeft: 0, textAlign: "left" },
	checkSpace: { width: 22 },
	message: {
		fontSize: 15,
		lineHeight: 22,
		paddingHorizontal: 16,
		paddingTop: 16,
	},
	status: { paddingTop: 24, alignItems: "center", gap: 8 },
	search: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderRadius: 12,
		paddingHorizontal: 12,
		marginTop: 20,
	},
	searchInput: { flex: 1, fontSize: 17, minHeight: 44, paddingVertical: 12 },
	listGap: { height: 24 },
	firstOption: {
		borderTopLeftRadius: 16,
		borderTopRightRadius: 16,
		overflow: "hidden",
	},
	lastOption: {
		borderBottomLeftRadius: 16,
		borderBottomRightRadius: 16,
		overflow: "hidden",
	},
});

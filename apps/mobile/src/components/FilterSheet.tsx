import { Ionicons } from "@expo/vector-icons";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/theme";

export type LibraryGrouping = "years" | "months" | "all";

interface FilterSheetProps {
	visible: boolean;
	onClose: () => void;
	filterOptions?: {
		cameras: string[];
		lenses: string[];
		isos: number[];
		dates: string[];
	};
	activeFilters: {
		camera: string | null;
		lens: string | null;
		iso: number | null;
		dateMonth: string | null;
	};
	onFilterChange: (filters: {
		camera: string | null;
		lens: string | null;
		iso: number | null;
		dateMonth: string | null;
	}) => void;
	grouping?: LibraryGrouping;
	onGroupingChange?: (grouping: LibraryGrouping) => void;
	onScan?: () => void;
	scanDisabled?: boolean;
	isScanning?: boolean;
	onOpenSettings?: () => void;
	isLoadingFilters?: boolean;
	filtersError?: boolean;
	onRetryFilters?: () => void;
}

const GROUPING_OPTIONS: Array<{ value: LibraryGrouping; label: string }> = [
	{ value: "years", label: "Years" },
	{ value: "months", label: "Months" },
	{ value: "all", label: "All Photos" },
];

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

function formatDateMonth(dateStr: string): string {
	const parts = dateStr.replace(/^([0-9]{4}):([0-9]{2})/, "$1-$2").split("-");
	if (parts.length !== 2) return dateStr;
	const year = parts[0];
	const monthIndex = Number.parseInt(parts[1], 10) - 1;
	if (monthIndex < 0 || monthIndex > 11) return dateStr;
	return `${MONTH_NAMES[monthIndex]} ${year}`;
}

export default function FilterSheet({
	visible,
	onClose,
	filterOptions,
	activeFilters,
	onFilterChange,
	grouping,
	onGroupingChange,
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

	const handleClearAll = () => {
		onFilterChange({
			camera: null,
			lens: null,
			iso: null,
			dateMonth: null,
		});
	};

	const toggleCamera = (value: string) => {
		onFilterChange({
			...activeFilters,
			camera: activeFilters.camera === value ? null : value,
		});
	};

	const toggleLens = (value: string) => {
		onFilterChange({
			...activeFilters,
			lens: activeFilters.lens === value ? null : value,
		});
	};

	const toggleIso = (value: number) => {
		onFilterChange({
			...activeFilters,
			iso: activeFilters.iso === value ? null : value,
		});
	};

	const toggleDate = (value: string) => {
		onFilterChange({
			...activeFilters,
			dateMonth: activeFilters.dateMonth === value ? null : value,
		});
	};

	const hasActiveFilters =
		activeFilters.camera !== null ||
		activeFilters.lens !== null ||
		activeFilters.iso !== null ||
		activeFilters.dateMonth !== null;

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<View style={[styles.container, { backgroundColor: colors.background }]}>
				{/* Header */}
				<View
					style={[
						styles.header,
						{
							backgroundColor: colors.toolbar,
							paddingTop: insets.top > 0 ? insets.top : 16,
						},
					]}
				>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Clear all filters"
						onPress={handleClearAll}
						disabled={!hasActiveFilters}
						style={styles.headerActionButton}
					>
						<Text
							style={[
								styles.headerAction,
								{
									color: hasActiveFilters
										? colors.primary
										: colors.mutedForeground,
								},
							]}
						>
							Clear All
						</Text>
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Apply filters"
						onPress={onClose}
						style={styles.headerActionButton}
					>
						<Text style={[styles.headerAction, { color: colors.primary }]}>
							Done
						</Text>
					</Pressable>
				</View>
				<Text
					accessibilityRole="header"
					style={[
						styles.headerTitle,
						{ color: colors.foreground, backgroundColor: colors.toolbar },
					]}
				>
					Library Options
				</Text>

				<ScrollView
					style={styles.content}
					contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
				>
					{grouping && onGroupingChange && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								Group By
							</Text>
							<View
								style={[
									styles.groupingControl,
									{ backgroundColor: colors.card },
								]}
							>
								{GROUPING_OPTIONS.map((option) => {
									const selected = grouping === option.value;
									return (
										<Pressable
											key={option.value}
											accessibilityRole="radio"
											accessibilityState={{ checked: selected }}
											onPress={() => onGroupingChange(option.value)}
											style={[
												styles.groupingOption,
												selected && { backgroundColor: colors.foreground },
											]}
										>
											<Text
												style={[
													styles.groupingLabel,
													{
														color: selected
															? colors.background
															: colors.foreground,
													},
												]}
											>
												{option.label}
											</Text>
										</Pressable>
									);
								})}
							</View>
						</View>
					)}

					{(onScan || onOpenSettings) && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								Library
							</Text>
							{onScan && (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Scan library"
									disabled={scanDisabled}
									onPress={onScan}
									style={[
										styles.optionRow,
										{ borderBottomColor: colors.border },
									]}
								>
									<View style={styles.libraryActionLabel}>
										<Ionicons
											name="sync-outline"
											size={20}
											color={
												scanDisabled ? colors.mutedForeground : colors.primary
											}
										/>
										<Text
											style={[
												styles.optionText,
												{
													color: scanDisabled
														? colors.mutedForeground
														: colors.foreground,
												},
											]}
										>
											Scan Library
										</Text>
									</View>
									{isScanning ? (
										<ActivityIndicator size="small" color={colors.primary} />
									) : (
										<Ionicons
											name="chevron-forward"
											size={18}
											color={colors.mutedForeground}
										/>
									)}
								</Pressable>
							)}
							{onOpenSettings && (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Open settings"
									onPress={onOpenSettings}
									style={[
										styles.optionRow,
										{ borderBottomColor: colors.border },
									]}
								>
									<View style={styles.libraryActionLabel}>
										<Ionicons
											name="settings-outline"
											size={20}
											color={colors.primary}
										/>
										<Text
											style={[styles.optionText, { color: colors.foreground }]}
										>
											Settings
										</Text>
									</View>
									<Ionicons
										name="chevron-forward"
										size={18}
										color={colors.mutedForeground}
									/>
								</Pressable>
							)}
						</View>
					)}

					{/* Camera Section */}
					{filterOptions?.cameras && filterOptions.cameras.length > 0 && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								Camera
							</Text>
							{filterOptions.cameras.map((camera) => {
								const isSelected = activeFilters.camera === camera;
								return (
									<Pressable
										key={camera}
										accessibilityRole="radio"
										accessibilityState={{ checked: isSelected }}
										style={[
											styles.optionRow,
											{ borderBottomColor: colors.border },
										]}
										onPress={() => toggleCamera(camera)}
									>
										<Text
											style={[
												styles.optionText,
												{
													color: isSelected
														? colors.primary
														: colors.foreground,
												},
											]}
										>
											{camera}
										</Text>
										{isSelected && (
											<Ionicons
												name="checkmark"
												size={20}
												color={colors.primary}
											/>
										)}
									</Pressable>
								);
							})}
						</View>
					)}

					{/* Lens Section */}
					{filterOptions?.lenses && filterOptions.lenses.length > 0 && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								Lens
							</Text>
							{filterOptions.lenses.map((lens) => {
								const isSelected = activeFilters.lens === lens;
								return (
									<Pressable
										key={lens}
										accessibilityRole="radio"
										accessibilityState={{ checked: isSelected }}
										style={[
											styles.optionRow,
											{ borderBottomColor: colors.border },
										]}
										onPress={() => toggleLens(lens)}
									>
										<Text
											style={[
												styles.optionText,
												{
													color: isSelected
														? colors.primary
														: colors.foreground,
												},
											]}
										>
											{lens}
										</Text>
										{isSelected && (
											<Ionicons
												name="checkmark"
												size={20}
												color={colors.primary}
											/>
										)}
									</Pressable>
								);
							})}
						</View>
					)}

					{/* ISO Section */}
					{filterOptions?.isos && filterOptions.isos.length > 0 && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								ISO
							</Text>
							{filterOptions.isos.map((iso) => {
								const isSelected = activeFilters.iso === iso;
								return (
									<Pressable
										key={iso}
										accessibilityRole="radio"
										accessibilityState={{ checked: isSelected }}
										style={[
											styles.optionRow,
											{ borderBottomColor: colors.border },
										]}
										onPress={() => toggleIso(iso)}
									>
										<Text
											style={[
												styles.optionText,
												{
													color: isSelected
														? colors.primary
														: colors.foreground,
												},
											]}
										>
											ISO {iso}
										</Text>
										{isSelected && (
											<Ionicons
												name="checkmark"
												size={20}
												color={colors.primary}
											/>
										)}
									</Pressable>
								);
							})}
						</View>
					)}

					{/* Date Section */}
					{filterOptions?.dates && filterOptions.dates.length > 0 && (
						<View style={styles.section}>
							<Text
								style={[styles.sectionTitle, { color: colors.mutedForeground }]}
							>
								Date
							</Text>
							{filterOptions.dates.map((date) => {
								const isSelected = activeFilters.dateMonth === date;
								return (
									<Pressable
										key={date}
										accessibilityRole="radio"
										accessibilityState={{ checked: isSelected }}
										style={[
											styles.optionRow,
											{ borderBottomColor: colors.border },
										]}
										onPress={() => toggleDate(date)}
									>
										<Text
											style={[
												styles.optionText,
												{
													color: isSelected
														? colors.primary
														: colors.foreground,
												},
											]}
										>
											{formatDateMonth(date)}
										</Text>
										{isSelected && (
											<Ionicons
												name="checkmark"
												size={20}
												color={colors.primary}
											/>
										)}
									</Pressable>
								);
							})}
						</View>
					)}

					{/* Empty state when no filter options available */}
					{!filterOptions && (isLoadingFilters || filtersError) ? (
						<View style={styles.emptyState}>
							{isLoadingFilters && <ActivityIndicator color={colors.primary} />}
							<Text
								style={[styles.emptyText, { color: colors.mutedForeground }]}
							>
								{isLoadingFilters
									? "Loading filters..."
									: "Couldn't load filters"}
							</Text>
							{!isLoadingFilters && onRetryFilters && (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Retry filters"
									onPress={onRetryFilters}
									style={styles.headerActionButton}
								>
									<Text
										style={[styles.headerAction, { color: colors.primary }]}
									>
										Try Again
									</Text>
								</Pressable>
							)}
						</View>
					) : (
						(!filterOptions ||
							(filterOptions.cameras.length === 0 &&
								filterOptions.lenses.length === 0 &&
								filterOptions.isos.length === 0 &&
								filterOptions.dates.length === 0)) && (
							<View style={styles.emptyState}>
								<Ionicons
									name="funnel-outline"
									size={48}
									color={colors.mutedForeground}
									style={{ opacity: 0.3 }}
								/>
								<Text
									style={[styles.emptyText, { color: colors.mutedForeground }]}
								>
									No filter options available
								</Text>
							</View>
						)
					)}
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingBottom: 12,
		paddingHorizontal: 16,
	},
	headerTitle: {
		fontSize: 24,
		fontWeight: "700",
		paddingHorizontal: 16,
		paddingBottom: 16,
	},
	headerActionButton: {
		minWidth: 72,
		minHeight: 44,
		justifyContent: "center",
		alignItems: "center",
	},
	headerAction: {
		fontSize: 16,
		fontWeight: "500",
	},
	content: {
		flex: 1,
	},
	section: {
		paddingTop: 20,
	},
	sectionTitle: {
		fontSize: 13,
		fontWeight: "600",
		paddingHorizontal: 16,
		paddingBottom: 8,
	},
	groupingControl: {
		flexDirection: "row",
		marginHorizontal: 16,
		padding: 3,
		borderRadius: 12,
		borderCurve: "continuous",
	},
	groupingOption: {
		flex: 1,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
		paddingVertical: 8,
		borderRadius: 10,
		borderCurve: "continuous",
	},
	groupingLabel: {
		fontSize: 13,
		fontWeight: "600",
	},
	optionRow: {
		flexDirection: "row",
		minHeight: 48,
		alignItems: "center",
		justifyContent: "space-between",
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	optionText: {
		fontSize: 16,
		flex: 1,
	},
	libraryActionLabel: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	emptyState: {
		alignItems: "center",
		justifyContent: "center",
		paddingVertical: 64,
		gap: 12,
	},
	emptyText: {
		fontSize: 16,
	},
});

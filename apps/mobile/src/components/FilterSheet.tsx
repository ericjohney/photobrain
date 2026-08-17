import { Ionicons } from "@expo/vector-icons";
import {
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/theme";

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
}

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
					<Text style={[styles.headerTitle, { color: colors.foreground }]}>
						Filters
					</Text>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Apply filters"
						onPress={onClose}
					>
						<Text style={[styles.headerAction, { color: colors.primary }]}>
							Done
						</Text>
					</Pressable>
				</View>

				<ScrollView style={styles.content}>
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
										accessibilityRole="checkbox"
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
										accessibilityRole="checkbox"
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
										accessibilityRole="checkbox"
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
										accessibilityRole="checkbox"
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
					{(!filterOptions ||
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
		fontSize: 18,
		fontWeight: "600",
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
	optionRow: {
		flexDirection: "row",
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

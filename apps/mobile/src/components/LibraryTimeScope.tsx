import {
	type LayoutChangeEvent,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import type { LibraryGrouping } from "@/components/FilterSheet";
import GlassSurface from "@/components/GlassSurface";
import { useColors } from "@/theme";

const SCOPES: Array<{ value: LibraryGrouping; label: string }> = [
	{ value: "years", label: "Years" },
	{ value: "months", label: "Months" },
	{ value: "all", label: "All Photos" },
];

interface LibraryTimeScopeProps {
	grouping: LibraryGrouping;
	onGroupingChange: (grouping: LibraryGrouping) => void;
	onLayout: (event: LayoutChangeEvent) => void;
}

export default function LibraryTimeScope({
	grouping,
	onGroupingChange,
	onLayout,
}: LibraryTimeScopeProps) {
	const colors = useColors();
	const { fontScale } = useWindowDimensions();

	return (
		<View onLayout={onLayout} style={styles.container}>
			<GlassSurface
				style={styles.surface}
				fallbackStyle={{ backgroundColor: colors.card }}
			>
				<View accessibilityRole="tablist" style={styles.segments}>
					{SCOPES.map(({ value, label }) => (
						<Pressable
							key={value}
							accessibilityRole="tab"
							accessibilityLabel={label}
							accessibilityState={{ selected: grouping === value }}
							onPress={() => onGroupingChange(value)}
							style={({ pressed }) => [
								styles.segment,
								{ flexBasis: 88 * fontScale },
								grouping === value && { backgroundColor: colors.primary },
								pressed && styles.pressed,
							]}
						>
							<Text
								style={[
									styles.label,
									{
										color:
											grouping === value
												? colors.primaryForeground
												: colors.foreground,
									},
								]}
							>
								{label}
							</Text>
						</Pressable>
					))}
				</View>
			</GlassSurface>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { width: "100%", maxWidth: 420, alignSelf: "center" },
	surface: { borderRadius: 28, borderCurve: "continuous", overflow: "hidden" },
	segments: { flexDirection: "row", flexWrap: "wrap", padding: 4, gap: 2 },
	segment: {
		flexGrow: 1,
		flexShrink: 1,
		minHeight: 44,
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 24,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
	pressed: { opacity: 0.7 },
});

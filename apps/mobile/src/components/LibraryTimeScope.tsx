import { Ionicons } from "@expo/vector-icons";
import {
	type LayoutChangeEvent,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import type { LibraryGrouping } from "@/components/FilterSheet";
import GlassSurface from "@/components/GlassSurface";
import { useColors } from "@/theme";

const SCOPES: Array<{ value: LibraryGrouping; label: string }> = [
	{ value: "years", label: "Years" },
	{ value: "months", label: "Months" },
	{ value: "all", label: "All" },
];

interface LibraryTimeScopeProps {
	grouping: LibraryGrouping;
	onGroupingChange: (grouping: LibraryGrouping) => void;
	onShowCollections: () => void;
	onShowSearch: () => void;
	onLayout: (event: LayoutChangeEvent) => void;
}

export default function LibraryTimeScope({
	grouping,
	onGroupingChange,
	onShowCollections,
	onShowSearch,
	onLayout,
}: LibraryTimeScopeProps) {
	const colors = useColors();
	const fallbackStyle = { backgroundColor: colors.card };

	return (
		<View
			testID="library-browsing-bar"
			onLayout={onLayout}
			style={styles.container}
		>
			<GlassSurface
				style={styles.roundSurface}
				fallbackStyle={fallbackStyle}
				isInteractive
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Show Collections"
					hitSlop={4}
					onPress={onShowCollections}
					style={({ pressed }) => [
						styles.roundButton,
						pressed && styles.pressed,
					]}
				>
					<Ionicons name="albums-outline" size={22} color={colors.foreground} />
				</Pressable>
			</GlassSurface>

			<GlassSurface style={styles.scopeSurface} fallbackStyle={fallbackStyle}>
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
								grouping === value && { backgroundColor: colors.primary },
								pressed && styles.pressed,
							]}
						>
							<Text
								adjustsFontSizeToFit
								minimumFontScale={0.75}
								numberOfLines={1}
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

			<GlassSurface
				style={styles.roundSurface}
				fallbackStyle={fallbackStyle}
				isInteractive
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Search Photos"
					hitSlop={4}
					onPress={onShowSearch}
					style={({ pressed }) => [
						styles.roundButton,
						pressed && styles.pressed,
					]}
				>
					<Ionicons name="search" size={23} color={colors.foreground} />
				</Pressable>
			</GlassSurface>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		width: "100%",
		maxWidth: 480,
		alignSelf: "center",
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	roundSurface: {
		width: 52,
		height: 52,
		borderRadius: 26,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	roundButton: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	scopeSurface: {
		flex: 1,
		minWidth: 0,
		borderRadius: 28,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	segments: {
		height: 52,
		flexDirection: "row",
		padding: 4,
		gap: 2,
	},
	segment: {
		flex: 1,
		minWidth: 0,
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 24,
		paddingHorizontal: 4,
	},
	label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
	pressed: { opacity: 0.7 },
});

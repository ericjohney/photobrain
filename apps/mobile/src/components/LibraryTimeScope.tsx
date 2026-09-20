import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
	Animated,
	Easing,
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

const SEGMENT_GAP = 2;
const SEGMENT_PADDING = 4;
const SELECTION_DURATION_MS = 260;
const USE_NATIVE_DRIVER = process.env.NODE_ENV !== "test";

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
	const selectedIndex = SCOPES.findIndex(({ value }) => value === grouping);
	const [segmentsWidth, setSegmentsWidth] = useState(0);
	const position = useRef(new Animated.Value(selectedIndex)).current;
	const stretch = useRef(new Animated.Value(1)).current;
	const previousIndex = useRef(selectedIndex);
	const segmentWidth =
		segmentsWidth > 0
			? (segmentsWidth -
					SEGMENT_PADDING * 2 -
					SEGMENT_GAP * (SCOPES.length - 1)) /
				SCOPES.length
			: 0;

	useEffect(() => {
		if (segmentWidth === 0) return;

		const priorIndex = previousIndex.current;
		position.stopAnimation();
		stretch.stopAnimation();

		if (priorIndex === selectedIndex) {
			position.setValue(selectedIndex);
			stretch.setValue(1);
			return;
		}

		const distance = Math.abs(selectedIndex - priorIndex);
		previousIndex.current = selectedIndex;
		stretch.setValue(1);

		Animated.parallel([
			Animated.timing(position, {
				toValue: selectedIndex,
				duration: SELECTION_DURATION_MS,
				easing: Easing.bezier(0.2, 0.8, 0.2, 1),
				useNativeDriver: USE_NATIVE_DRIVER,
			}),
			Animated.sequence([
				Animated.timing(stretch, {
					toValue: 1 + distance * 0.75,
					duration: 110,
					easing: Easing.out(Easing.cubic),
					useNativeDriver: USE_NATIVE_DRIVER,
				}),
				Animated.timing(stretch, {
					toValue: 1,
					duration: SELECTION_DURATION_MS - 110,
					easing: Easing.inOut(Easing.cubic),
					useNativeDriver: USE_NATIVE_DRIVER,
				}),
			]),
		]).start();
	}, [position, segmentWidth, selectedIndex, stretch]);

	const selectionOffset = position.interpolate({
		inputRange: [0, SCOPES.length - 1],
		outputRange: [0, (SCOPES.length - 1) * (segmentWidth + SEGMENT_GAP)],
	});

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

			<GlassSurface
				style={styles.scopeSurface}
				fallbackStyle={fallbackStyle}
				glassEffectStyle="clear"
			>
				<View
					testID="library-scope-track"
					accessibilityRole="tablist"
					onLayout={({ nativeEvent }) =>
						setSegmentsWidth(nativeEvent.layout.width)
					}
					style={styles.segments}
				>
					{segmentWidth > 0 && (
						<Animated.View
							pointerEvents="none"
							testID="library-scope-selection-track"
							style={[
								styles.selectionTrack,
								{
									width: segmentWidth,
									transform: [
										{ translateX: selectionOffset },
										{ scaleX: stretch },
									],
								},
							]}
						>
							<GlassSurface
								testID="library-scope-selection"
								style={styles.selectionSurface}
								fallbackStyle={{ backgroundColor: colors.secondary }}
								isInteractive
							/>
						</Animated.View>
					)}
					{SCOPES.map(({ value, label }) => {
						const selected = grouping === value;
						return (
							<Pressable
								key={value}
								accessibilityRole="tab"
								accessibilityLabel={label}
								accessibilityState={{ selected }}
								onPress={() => onGroupingChange(value)}
								style={({ pressed }) => [
									styles.segment,
									pressed && styles.pressed,
								]}
							>
								<Text
									adjustsFontSizeToFit
									minimumFontScale={0.75}
									numberOfLines={1}
									style={[styles.label, { color: colors.foreground }]}
								>
									{label}
								</Text>
							</Pressable>
						);
					})}
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
		padding: SEGMENT_PADDING,
		gap: SEGMENT_GAP,
		position: "relative",
	},
	selectionTrack: {
		position: "absolute",
		top: SEGMENT_PADDING,
		left: SEGMENT_PADDING,
		height: 44,
	},
	selectionSurface: {
		flex: 1,
		borderRadius: 22,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	segment: {
		zIndex: 1,
		flex: 1,
		minWidth: 0,
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 22,
		paddingHorizontal: 4,
	},
	label: { fontSize: 14, fontWeight: "600", textAlign: "center" },
	pressed: { opacity: 0.7 },
});

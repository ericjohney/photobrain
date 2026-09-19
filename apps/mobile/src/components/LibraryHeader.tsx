import { Ionicons } from "@expo/vector-icons";
import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import {
	type LayoutChangeEvent,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme";
import GlassSurface, { useGlassAvailability } from "./GlassSurface";

interface LibraryHeaderProps {
	subtitle: string;
	isOverPhotos: boolean;
	isSelecting: boolean;
	selectionDisabled: boolean;
	hasActiveFilters: boolean;
	onOptions: () => void;
	onToggleSelection: () => void;
	onLayout: (event: LayoutChangeEvent) => void;
}

export default function LibraryHeader({
	subtitle,
	isOverPhotos,
	isSelecting,
	selectionDisabled,
	hasActiveFilters,
	onOptions,
	onToggleSelection,
	onLayout,
}: LibraryHeaderProps) {
	const { colors, isDark } = useTheme();
	const insets = useSafeAreaInsets();
	const { width, fontScale } = useWindowDimensions();
	const canRenderGlass = useGlassAvailability();
	const foreground = isOverPhotos ? "#ffffff" : colors.foreground;
	const stacked = fontScale > 1.3 || width - insets.left - insets.right < 340;
	const disableSelection = selectionDisabled && !isSelecting;
	const colorScheme = isOverPhotos || isDark ? "dark" : "light";
	const buttonFallback = {
		backgroundColor: isOverPhotos ? "#2c2c2e" : colors.card,
	};

	return (
		<View
			testID="library-header"
			pointerEvents="box-none"
			onLayout={onLayout}
			style={[
				styles.header,
				{
					paddingTop: insets.top + 8,
					paddingLeft: insets.left + 16,
					paddingRight: insets.right + 16,
				},
			]}
		>
			{isOverPhotos && canRenderGlass ? (
				<MaskedView
					pointerEvents="none"
					accessible={false}
					accessibilityElementsHidden
					importantForAccessibility="no-hide-descendants"
					style={styles.backdrop}
					maskElement={<View style={styles.backdropMask} />}
				>
					<BlurView
						pointerEvents="none"
						tint="default"
						intensity={24}
						style={StyleSheet.absoluteFill}
					/>
					<View style={styles.scrim} />
				</MaskedView>
			) : (
				<View
					pointerEvents="none"
					style={[
						StyleSheet.absoluteFill,
						{
							backgroundColor: isOverPhotos ? "#1c1c1e" : colors.background,
						},
					]}
				/>
			)}
			<View
				pointerEvents="box-none"
				style={[styles.titleRow, stacked && styles.titleRowStacked]}
			>
				<View pointerEvents="none" style={styles.titleBlock}>
					<Text
						accessibilityRole="header"
						style={[
							styles.title,
							{ color: foreground },
							isOverPhotos && styles.textOverPhotos,
						]}
					>
						Library
					</Text>
					<Text
						style={[
							styles.subtitle,
							{ color: foreground },
							isOverPhotos && styles.textOverPhotos,
						]}
					>
						{subtitle}
					</Text>
				</View>
				<View pointerEvents="box-none" style={styles.actions}>
					<GlassSurface
						pointerEvents="box-none"
						style={styles.buttonSurface}
						fallbackStyle={buttonFallback}
						glassEffectStyle="clear"
						colorScheme={colorScheme}
						isInteractive
					>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={
								hasActiveFilters
									? "Library options, filters active"
									: "Library options"
							}
							onPress={onOptions}
							style={({ pressed }) => [
								styles.roundButton,
								pressed && styles.pressedButton,
							]}
						>
							<Ionicons name="filter" size={24} color={foreground} />
							{hasActiveFilters && (
								<View
									style={[
										styles.filterIndicator,
										{
											backgroundColor: isOverPhotos
												? "#64a8ff"
												: colors.primary,
										},
									]}
								/>
							)}
						</Pressable>
					</GlassSurface>
					<GlassSurface
						pointerEvents="box-none"
						style={styles.buttonSurface}
						fallbackStyle={buttonFallback}
						glassEffectStyle="clear"
						colorScheme={colorScheme}
						isInteractive
					>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={
								isSelecting ? "Finish selecting photos" : "Select photos"
							}
							accessibilityState={{ disabled: disableSelection }}
							disabled={disableSelection}
							onPress={onToggleSelection}
							style={({ pressed }) => [
								isSelecting ? styles.roundButton : styles.selectButton,
								disableSelection && styles.disabledButton,
								pressed && styles.pressedButton,
							]}
						>
							{isSelecting ? (
								<Ionicons name="close" size={24} color={foreground} />
							) : (
								<Text style={[styles.selectText, { color: foreground }]}>
									Select
								</Text>
							)}
						</Pressable>
					</GlassSurface>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	header: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		paddingBottom: 12,
	},
	backdrop: {
		...StyleSheet.absoluteFill,
		bottom: -32,
	},
	backdropMask: {
		flex: 1,
		experimental_backgroundImage:
			"linear-gradient(to bottom, black 0%, black 65%, transparent 100%)",
	},
	scrim: {
		...StyleSheet.absoluteFill,
		experimental_backgroundImage:
			"linear-gradient(to bottom, rgba(0,0,0,0.48) 0%, rgba(0,0,0,0.38) 55%, rgba(0,0,0,0) 100%)",
	},
	titleRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 12,
	},
	titleRowStacked: {
		flexDirection: "column",
	},
	titleBlock: {
		flexGrow: 1,
		flexShrink: 1,
	},
	title: {
		fontSize: 34,
		fontWeight: "700",
		letterSpacing: -0.8,
	},
	subtitle: {
		fontSize: 15,
		fontWeight: "600",
		marginTop: 1,
	},
	textOverPhotos: {
		textShadowColor: "rgba(0,0,0,0.3)",
		textShadowOffset: { width: 0, height: 1 },
		textShadowRadius: 4,
	},
	actions: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	buttonSurface: {
		borderRadius: 999,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	roundButton: {
		width: 44,
		height: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	selectButton: {
		minHeight: 44,
		paddingHorizontal: 16,
		paddingVertical: 10,
		alignItems: "center",
		justifyContent: "center",
	},
	selectText: {
		fontSize: 17,
		fontWeight: "500",
	},
	filterIndicator: {
		position: "absolute",
		top: 7,
		right: 7,
		width: 7,
		height: 7,
		borderRadius: 4,
	},
	disabledButton: {
		opacity: 0.4,
	},
	pressedButton: {
		opacity: 0.65,
	},
});

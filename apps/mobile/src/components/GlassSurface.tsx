import {
	GlassView,
	type GlassViewProps,
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import { useEffect, useState } from "react";
import {
	AccessibilityInfo,
	Platform,
	StyleSheet,
	View,
	type ViewStyle,
} from "react-native";
import { useTheme } from "@/theme";

interface GlassSurfaceProps extends GlassViewProps {
	fallbackStyle?: ViewStyle;
}

export default function GlassSurface({
	children,
	style,
	fallbackStyle,
	glassEffectStyle = "regular",
	tintColor,
	colorScheme,
	...props
}: GlassSurfaceProps) {
	const { isDark } = useTheme();
	const [reduceTransparency, setReduceTransparency] = useState<boolean | null>(
		null,
	);

	useEffect(() => {
		if (
			Platform.OS !== "ios" ||
			typeof AccessibilityInfo.isReduceTransparencyEnabled !== "function"
		) {
			return;
		}
		let mounted = true;
		let preferenceChanged = false;
		const subscription = AccessibilityInfo.addEventListener?.(
			"reduceTransparencyChanged",
			(enabled) => {
				preferenceChanged = true;
				if (mounted) setReduceTransparency(enabled);
			},
		);
		AccessibilityInfo.isReduceTransparencyEnabled()
			.then((enabled) => {
				if (mounted && !preferenceChanged) setReduceTransparency(enabled);
			})
			.catch(() => {
				// Keep the opaque fallback until the preference is known.
			});

		return () => {
			mounted = false;
			subscription?.remove();
		};
	}, []);

	const canRenderGlass =
		Platform.OS === "ios" &&
		reduceTransparency === false &&
		isLiquidGlassAvailable() &&
		isGlassEffectAPIAvailable();

	if (canRenderGlass) {
		return (
			<GlassView
				{...props}
				style={style}
				glassEffectStyle={glassEffectStyle}
				tintColor={tintColor}
				colorScheme={colorScheme ?? (isDark ? "dark" : "light")}
			>
				{children}
			</GlassView>
		);
	}

	return (
		<View
			{...props}
			style={[
				style,
				styles.fallback,
				{
					backgroundColor: isDark ? "#2c2c2e" : "#f2f2f7",
				},
				fallbackStyle,
			]}
		>
			{children}
		</View>
	);
}

const styles = StyleSheet.create({
	fallback: {
		borderCurve: "continuous",
	},
});

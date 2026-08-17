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
	const [reduceTransparency, setReduceTransparency] = useState(false);

	useEffect(() => {
		if (
			Platform.OS !== "ios" ||
			typeof AccessibilityInfo.isReduceTransparencyEnabled !== "function"
		) {
			return;
		}
		let mounted = true;
		AccessibilityInfo.isReduceTransparencyEnabled()
			.then((enabled) => {
				if (mounted && enabled) setReduceTransparency(true);
			})
			.catch(() => {
				// Keep the normal visual treatment if the preference cannot be read.
			});
		const subscription = AccessibilityInfo.addEventListener?.(
			"reduceTransparencyChanged",
			setReduceTransparency,
		);

		return () => {
			mounted = false;
			subscription?.remove();
		};
	}, []);

	const canRenderGlass =
		Platform.OS === "ios" &&
		!reduceTransparency &&
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
					backgroundColor: isDark
						? "rgba(44,44,46,0.94)"
						: "rgba(242,242,247,0.94)",
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

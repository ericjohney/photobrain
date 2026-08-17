import { Stack } from "expo-router";
import { Platform } from "react-native";
import { useColors } from "../../../src/theme";

export default function SearchLayout() {
	const colors = useColors();

	return (
		<Stack
			screenOptions={{
				headerShown: Platform.OS === "ios",
				headerLargeTitle: Platform.OS === "ios",
				headerTransparent: Platform.OS === "ios",
				headerBlurEffect: Platform.OS === "ios" ? "systemMaterial" : undefined,
				headerShadowVisible: false,
				headerTintColor: colors.foreground,
				contentStyle: { backgroundColor: colors.background },
			}}
		/>
	);
}

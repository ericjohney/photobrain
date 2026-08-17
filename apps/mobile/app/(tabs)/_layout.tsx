import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useColors } from "../../src/theme";

export default function TabLayout() {
	const colors = useColors();

	return (
		<NativeTabs
			minimizeBehavior="onScrollDown"
			disableTransparentOnScrollEdge
			tintColor={colors.primary}
			iconColor={{
				default: colors.mutedForeground,
				selected: colors.primary,
			}}
			labelStyle={{ color: colors.foreground }}
		>
			<NativeTabs.Trigger name="index" accessibilityLabel="Library">
				<NativeTabs.Trigger.Icon
					sf={{
						default: "photo.on.rectangle",
						selected: "photo.fill.on.rectangle.fill",
					}}
					md="photo_library"
				/>
				<NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
			</NativeTabs.Trigger>
			<NativeTabs.Trigger
				name="search"
				role="search"
				accessibilityLabel="Search"
			>
				<NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
				<NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}

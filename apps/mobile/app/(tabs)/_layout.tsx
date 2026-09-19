import { NativeTabs } from "expo-router/unstable-native-tabs";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { TabBarVisibilityContext } from "../../src/navigation/tab-bar-visibility";
import { useTheme } from "../../src/theme";

export default function TabLayout() {
	const { colors, isDark } = useTheme();
	const [isTabBarHidden, setIsTabBarHidden] = useState(false);

	return (
		<TabBarVisibilityContext.Provider value={setIsTabBarHidden}>
			<StatusBar style={isDark ? "light" : "dark"} />
			<NativeTabs
				hidden={isTabBarHidden}
				minimizeBehavior="onScrollDown"
				tintColor={colors.primary}
				iconColor={{
					default: colors.mutedForeground,
					selected: colors.primary,
				}}
				labelStyle={{
					default: { color: colors.mutedForeground },
					selected: { color: colors.primary },
				}}
			>
				<NativeTabs.Trigger
					name="index"
					accessibilityLabel="Library"
					disableAutomaticContentInsets
				>
					<NativeTabs.Trigger.Icon
						sf={{
							default: "photo.on.rectangle",
							selected: "photo.fill.on.rectangle.fill",
						}}
						md="photo_library"
					/>
					<NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
				</NativeTabs.Trigger>
				<NativeTabs.Trigger name="collections" accessibilityLabel="Collections">
					<NativeTabs.Trigger.Icon
						sf={{
							default: "rectangle.stack",
							selected: "rectangle.stack.fill",
						}}
						md="collections"
					/>
					<NativeTabs.Trigger.Label>Collections</NativeTabs.Trigger.Label>
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
		</TabBarVisibilityContext.Provider>
	);
}

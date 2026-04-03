import { Ionicons } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { trpc } from "../src/lib/trpc";
import { trpcClient } from "../src/lib/trpc-client";
import { ThemeProvider, useColors } from "../src/theme";

const queryClient = new QueryClient();

function TabsNavigator() {
	const colors = useColors();

	return (
		<Tabs
			screenOptions={{
				tabBarActiveTintColor: colors.foreground,
				tabBarInactiveTintColor: colors.mutedForeground,
				tabBarStyle: {
					backgroundColor: colors.background,
					borderTopColor: colors.border,
					borderTopWidth: 0.5,
					paddingTop: 4,
				},
				tabBarLabelStyle: {
					fontSize: 10,
					fontWeight: "500",
				},
				headerStyle: {
					backgroundColor: colors.background,
					shadowColor: "transparent",
					elevation: 0,
				},
				headerTintColor: colors.foreground,
				headerTitleStyle: {
					fontWeight: "700",
					fontSize: 18,
				},
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: "Photos",
					headerShown: false,
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "images" : "images-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					title: "Search",
					headerShown: false,
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "search" : "search-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="collections"
				options={{
					title: "Albums",
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "albums" : "albums-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="preferences"
				options={{
					title: "Library",
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "library" : "library-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="about"
				options={{
					href: null,
				}}
			/>
		</Tabs>
	);
}

export default function RootLayout() {
	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<StatusBar style="auto" />
					<TabsNavigator />
				</ThemeProvider>
			</QueryClientProvider>
		</trpc.Provider>
	);
}

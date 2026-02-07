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
				tabBarActiveTintColor: colors.primary,
				tabBarInactiveTintColor: colors.mutedForeground,
				tabBarStyle: {
					backgroundColor: colors.toolbar,
					borderTopColor: colors.border,
				},
				headerStyle: {
					backgroundColor: colors.toolbar,
				},
				headerTintColor: colors.foreground,
				headerTitleStyle: {
					fontWeight: "600",
				},
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: "Dashboard",
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
				name="collections"
				options={{
					title: "Collections",
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "folder" : "folder-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="preferences"
				options={{
					title: "Preferences",
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={focused ? "settings" : "settings-outline"}
							size={size}
							color={color}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="about"
				options={{
					title: "About",
					tabBarIcon: ({ focused, color, size }) => (
						<Ionicons
							name={
								focused
									? "information-circle"
									: "information-circle-outline"
							}
							size={size}
							color={color}
						/>
					),
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

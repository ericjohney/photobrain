import { StatusBar } from "expo-status-bar";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc } from "../src/lib/trpc";
import { trpcClient } from "../src/lib/trpc-client";

const queryClient = new QueryClient();

export default function RootLayout() {
	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<StatusBar style="auto" />
				<Tabs
					screenOptions={{
						tabBarActiveTintColor: "#3b82f6",
						tabBarInactiveTintColor: "gray",
						headerStyle: {
							backgroundColor: "#f3f4f6",
						},
						headerTintColor: "#111827",
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
									name={focused ? "information-circle" : "information-circle-outline"}
									size={size}
									color={color}
								/>
							),
						}}
					/>
				</Tabs>
			</QueryClientProvider>
		</trpc.Provider>
	);
}

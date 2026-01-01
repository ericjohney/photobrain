import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc } from "./src/lib/trpc";
import { trpcClient } from "./src/lib/trpc-client";
import DashboardScreen from "./src/screens/DashboardScreen";
import CollectionsScreen from "./src/screens/CollectionsScreen";
import PreferencesScreen from "./src/screens/PreferencesScreen";
import AboutScreen from "./src/screens/AboutScreen";

const Tab = createBottomTabNavigator();
const queryClient = new QueryClient();

export default function App() {
	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<StatusBar style="auto" />
				<NavigationContainer>
					<Tab.Navigator
						screenOptions={({ route }) => ({
							tabBarIcon: ({ focused, color, size }) => {
								let iconName: keyof typeof Ionicons.glyphMap = "home";

								if (route.name === "Dashboard") {
									iconName = focused ? "images" : "images-outline";
								} else if (route.name === "Collections") {
									iconName = focused ? "folder" : "folder-outline";
								} else if (route.name === "Preferences") {
									iconName = focused ? "settings" : "settings-outline";
								} else if (route.name === "About") {
									iconName = focused ? "information-circle" : "information-circle-outline";
								}

								return <Ionicons name={iconName} size={size} color={color} />;
							},
							tabBarActiveTintColor: "#3b82f6",
							tabBarInactiveTintColor: "gray",
							headerStyle: {
								backgroundColor: "#f3f4f6",
							},
							headerTintColor: "#111827",
							headerTitleStyle: {
								fontWeight: "600",
							},
						})}
					>
						<Tab.Screen name="Dashboard" component={DashboardScreen} />
						<Tab.Screen name="Collections" component={CollectionsScreen} />
						<Tab.Screen name="Preferences" component={PreferencesScreen} />
						<Tab.Screen name="About" component={AboutScreen} />
					</Tab.Navigator>
				</NavigationContainer>
			</QueryClientProvider>
		</trpc.Provider>
	);
}

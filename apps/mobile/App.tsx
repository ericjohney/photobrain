import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { trpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";
import AboutScreen from "@/screens/AboutScreen";
import CollectionsScreen from "@/screens/CollectionsScreen";
import DashboardScreen from "@/screens/DashboardScreen";
import PreferencesScreen from "@/screens/PreferencesScreen";
import { ThemeProvider, useColors, useTheme } from "@/theme";

const Tab = createBottomTabNavigator();
const queryClient = new QueryClient();

function AppContent() {
	const colors = useColors();
	const { isDark } = useTheme();

	return (
		<>
			<StatusBar style={isDark ? "light" : "dark"} />
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
								iconName = focused
									? "information-circle"
									: "information-circle-outline";
							}

							return <Ionicons name={iconName} size={size} color={color} />;
						},
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
						headerShadowVisible: false,
					})}
				>
					<Tab.Screen name="Dashboard" component={DashboardScreen} />
					<Tab.Screen name="Collections" component={CollectionsScreen} />
					<Tab.Screen name="Preferences" component={PreferencesScreen} />
					<Tab.Screen name="About" component={AboutScreen} />
				</Tab.Navigator>
			</NavigationContainer>
		</>
	);
}

export default function App() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<trpc.Provider client={trpcClient} queryClient={queryClient}>
				<QueryClientProvider client={queryClient}>
					<ThemeProvider>
						<AppContent />
					</ThemeProvider>
				</QueryClientProvider>
			</trpc.Provider>
		</GestureHandlerRootView>
	);
}

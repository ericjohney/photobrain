import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider as NavigationThemeProvider,
	Stack,
} from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { trpc } from "./lib/trpc";
import { trpcClient } from "./lib/trpc-client";
import { ThemeProvider, useTheme } from "./theme";

const queryClient = new QueryClient();

function AppNavigator() {
	const { colors, isDark } = useTheme();
	const baseTheme = isDark ? DarkTheme : DefaultTheme;
	const navigationTheme = {
		...baseTheme,
		colors: {
			...baseTheme.colors,
			primary: colors.primary,
			background: colors.background,
			card: colors.toolbar,
			text: colors.foreground,
			border: colors.border,
			notification: colors.destructive,
		},
	};

	return (
		<NavigationThemeProvider value={navigationTheme}>
			<StatusBar style={isDark ? "light" : "dark"} />
			<Stack
				screenOptions={{
					contentStyle: { backgroundColor: colors.background },
					headerTintColor: colors.foreground,
					headerShadowVisible: false,
					headerTransparent: Platform.OS === "ios",
					headerBlurEffect:
						Platform.OS === "ios" ? "systemMaterial" : undefined,
				}}
			>
				<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
				<Stack.Screen name="preferences" options={{ title: "Settings" }} />
				<Stack.Screen name="about" options={{ title: "About" }} />
				<Stack.Screen name="collections" options={{ title: "Albums" }} />
			</Stack>
		</NavigationThemeProvider>
	);
}

export default function RootApp() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<trpc.Provider client={trpcClient} queryClient={queryClient}>
				<QueryClientProvider client={queryClient}>
					<ThemeProvider>
						<AppNavigator />
					</ThemeProvider>
				</QueryClientProvider>
			</trpc.Provider>
		</GestureHandlerRootView>
	);
}

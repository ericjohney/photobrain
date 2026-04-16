import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";

// tRPC mock — must go BEFORE the component import
jest.mock("@/lib/trpc", () => ({
	trpc: {
		Provider: ({ children }: { children: React.ReactNode }) => children,
		photos: {
			useQuery: () => ({
				data: { photos: require("./fixtures").MOCK_PHOTOS },
				isLoading: false,
				isFetching: false,
				refetch: jest.fn(),
			}),
		},
		scan: {
			useMutation: (opts?: any) => ({
				mutate: jest.fn((...args: any[]) => {
					opts?.onSuccess?.({ jobId: "test-job-123" });
				}),
				isPending: false,
			}),
		},
		searchPhotos: {
			useQuery: () => ({ data: undefined, isFetching: false }),
		},
	},
}));

// Mock trpc-client
jest.mock("@/lib/trpc-client", () => ({
	trpcClient: {},
}));

// Mock useOTAUpdates hook
jest.mock("@/hooks/use-ota-updates", () => ({
	useOTAUpdates: jest.fn(),
}));

// Mock expo-status-bar
jest.mock("expo-status-bar", () => ({
	StatusBar: () => null,
}));

// Mock react-native-gesture-handler
jest.mock("react-native-gesture-handler", () => {
	const { View } = require("react-native");
	return {
		GestureHandlerRootView: ({ children, ...props }: any) =>
			require("react").createElement(View, props, children),
	};
});

// Mock @react-navigation/bottom-tabs to avoid native BottomTabView errors
jest.mock("@react-navigation/bottom-tabs", () => {
	const React = require("react");
	const { View, Text, Pressable } = require("react-native");

	function createBottomTabNavigator() {
		function Navigator({ children, screenOptions }: any) {
			const [activeTab, setActiveTab] = React.useState(0);
			const screens = React.Children.toArray(children);
			const activeScreen = screens[activeTab] as any;
			const Component = activeScreen?.props?.component;

			return React.createElement(
				View,
				{ testID: "tab-navigator" },
				Component ? React.createElement(Component, null) : null,
				React.createElement(
					View,
					{ testID: "tab-bar" },
					screens.map((screen: any, index: number) =>
						React.createElement(
							Pressable,
							{
								key: screen.props.name,
								onPress: () => setActiveTab(index),
								testID: `tab-${screen.props.name}`,
							},
							React.createElement(Text, null, screen.props.name),
						),
					),
				),
			);
		}

		function Screen(_props: any) {
			return null;
		}

		return { Navigator, Screen };
	}

	return { createBottomTabNavigator };
});

import App from "../App";

describe("Tab Navigation", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("renders the Dashboard tab by default", async () => {
		const { getByText } = render(<App />);
		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});
	});

	it("switches to the About tab", async () => {
		const { getByText } = render(<App />);
		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});

		fireEvent.press(getByText("About"));

		await waitFor(() => {
			expect(getByText("Version 0.1.0")).toBeTruthy();
		});
	});

	it("switches to Preferences tab and back to Dashboard", async () => {
		const { getByText } = render(<App />);
		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});

		fireEvent.press(getByText("Preferences"));

		// After switching, Dashboard content should be gone, Preferences tab visible
		await waitFor(() => {
			expect(getByText("Preferences")).toBeTruthy();
		});

		fireEvent.press(getByText("Dashboard"));

		await waitFor(() => {
			expect(getByText("PhotoBrain")).toBeTruthy();
		});
	});
});

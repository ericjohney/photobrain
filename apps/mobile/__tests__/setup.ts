import { configure } from "@testing-library/react-native";

configure({ asyncUtilTimeout: 5000 });

// Mock react-native-reanimated (manual mock — /mock entry point requires native worklets)
jest.mock("react-native-reanimated", () => {
	const { View } = require("react-native");
	return {
		__esModule: true,
		default: {
			createAnimatedComponent: (component: any) => component,
			View,
			call: () => {},
		},
		useSharedValue: (init: any) => ({ value: init }),
		useAnimatedStyle: (fn: () => any) => fn(),
		withTiming: (value: any) => value,
		withSpring: (value: any) => value,
		withDecay: (value: any) => value,
		Easing: { linear: (x: any) => x, ease: (x: any) => x },
		createAnimatedComponent: (component: any) => component,
	};
});

// Mock react-native-gesture-handler Gesture API
jest.mock("react-native-gesture-handler", () => {
	const View = require("react-native").View;
	const createChainableGesture = () => {
		const gesture: any = {};
		const methods = [
			"onUpdate",
			"onEnd",
			"onStart",
			"minPointers",
			"numberOfTaps",
			"maxDuration",
			"manualActivation",
			"onTouchesMove",
		];
		for (const method of methods) {
			gesture[method] = (..._args: any[]) => gesture;
		}
		return gesture;
	};
	return {
		GestureHandlerRootView: View,
		GestureDetector: ({ children }: { children: React.ReactNode }) => children,
		Gesture: {
			Pinch: () => createChainableGesture(),
			Pan: () => createChainableGesture(),
			Tap: () => createChainableGesture(),
			Simultaneous: (...args: any[]) => args[0],
		},
	};
});

// Mock expo-haptics
jest.mock("expo-haptics", () => ({
	selectionAsync: jest.fn(),
	impactAsync: jest.fn(),
	ImpactFeedbackStyle: {
		Light: "light",
		Medium: "medium",
		Heavy: "heavy",
	},
}));

// Mock expo-image — render as a View with testID and accessibilityLabel for URI checking
jest.mock("expo-image", () => {
	const { View } = require("react-native");
	return {
		Image: (props: any) => {
			const { testID, source, accessibilityLabel, ...rest } = props;
			return require("react").createElement(View, {
				testID: testID || "expo-image",
				accessibilityLabel:
					accessibilityLabel ??
					(typeof source?.uri === "string" ? source.uri : undefined),
				sourceUri: typeof source?.uri === "string" ? source.uri : undefined,
				...rest,
			});
		},
	};
});

// Mock Liquid Glass while preserving availability controls for component tests.
jest.mock("expo-glass-effect", () => {
	const { View } = require("react-native");
	return {
		GlassView: ({
			children,
			...props
		}: { children?: React.ReactNode; testID?: string } & Record<
			string,
			unknown
		>) =>
			require("react").createElement(
				View,
				{ ...props, testID: props.testID ?? "native-glass" },
				children,
			),
		isGlassEffectAPIAvailable: jest.fn(() => true),
		isLiquidGlassAvailable: jest.fn(() => true),
	};
});

// Mock expo-constants
jest.mock("expo-constants", () => ({
	expoConfig: {
		extra: {
			apiUrl: "http://test-api:3000",
		},
	},
}));

// Mock @/config
jest.mock("@/config", () => ({
	config: {
		API_URL: "http://test-api:3000",
		NODE_ENV: "test",
	},
	API_URL: "http://test-api:3000",
	thumbnailUrl: (photoId: number, size: string, updatedAt?: any) => {
		const base = `http://test-api:3000/api/photos/${photoId}/thumbnail/${size}`;
		if (!updatedAt) return base;
		const ts =
			updatedAt instanceof Date
				? updatedAt.getTime()
				: new Date(updatedAt).getTime();
		return `${base}?v=${ts}`;
	},
}));

// Mock expo-router
jest.mock("expo-router", () => {
	const React = require("react");
	const { TextInput, View } = require("react-native");
	const router = { push: jest.fn(), back: jest.fn() };
	const navigation = { setOptions: jest.fn() };
	const Stack = ({
		children,
		...props
	}: { children?: React.ReactNode } & Record<string, unknown>) =>
		React.createElement(View, { ...props, testID: "native-stack" }, children);
	Stack.Screen = () => null;
	Stack.SearchBar = ({
		ref: _ref,
		onChangeText,
		...props
	}: {
		ref?: unknown;
		onChangeText?: (event: { nativeEvent: { text: string } }) => void;
	} & Record<string, unknown>) => {
		return React.createElement(TextInput, {
			...props,
			testID: "native-search-bar",
			accessibilityLabel: "Search photos",
			onChangeText: (text: string) => onChangeText?.({ nativeEvent: { text } }),
		});
	};

	return {
		Stack,
		DefaultTheme: {
			dark: false,
			colors: {
				primary: "#007aff",
				background: "#ffffff",
				card: "#ffffff",
				text: "#000000",
				border: "#d1d1d6",
				notification: "#ff3b30",
			},
		},
		DarkTheme: {
			dark: true,
			colors: {
				primary: "#0a84ff",
				background: "#000000",
				card: "#1c1c1e",
				text: "#ffffff",
				border: "#38383a",
				notification: "#ff453a",
			},
		},
		ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
		useFocusEffect: (effect: () => undefined | (() => void)) =>
			React.useEffect(effect, [effect]),
		useNavigation: () => navigation,
		useRouter: () => router,
		__router: router,
		__navigation: navigation,
	};
});

jest.mock("expo-router/unstable-native-tabs", () => {
	const React = require("react");
	const { Text, View } = require("react-native");
	const NativeTabs = ({ children }: { children: React.ReactNode }) =>
		React.createElement(View, { testID: "native-tabs" }, children);
	NativeTabs.Trigger = ({
		children,
		name,
		...props
	}: { children?: React.ReactNode; name: string } & Record<string, unknown>) =>
		React.createElement(
			View,
			{ ...props, testID: `native-tab-${name}` },
			children,
		);
	NativeTabs.Trigger.Icon = () => null;
	NativeTabs.Trigger.Label = ({ children }: { children: React.ReactNode }) =>
		React.createElement(Text, null, children);
	return { NativeTabs };
});

// Mock react-native-safe-area-context
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
	SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock @react-native-async-storage/async-storage
jest.mock("@react-native-async-storage/async-storage", () => ({
	getItem: jest.fn().mockResolvedValue(null),
	setItem: jest.fn().mockResolvedValue(undefined),
	removeItem: jest.fn().mockResolvedValue(undefined),
}));

// Mock @expo/vector-icons — render icon name as text for querying
jest.mock("@expo/vector-icons", () => {
	const { Text } = require("react-native");
	return {
		Ionicons: ({ name, ...props }: any) =>
			require("react").createElement(
				Text,
				{ ...props, testID: `icon-${name}` },
				name,
			),
	};
});

// Mock @photobrain/utils
jest.mock("@photobrain/utils", () => ({
	formatFileSize: (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	},
	formatDate: (dateStr: string) => dateStr,
	parseDate: (value: Date | string | null | undefined) => {
		if (!value) return new Date(0);
		if (value instanceof Date) return value;
		const parsed = new Date(
			value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"),
		);
		return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
	},
}));

// Mock useJobProgress hook (not under test)
jest.mock("@/hooks/use-job-progress", () => ({
	useJobProgress: () => ({
		progress: null,
		isActive: false,
		isCompleted: false,
		isFailed: false,
		isConnected: false,
		error: null,
		failureMessage: null,
		allMessages: [],
	}),
}));

// Mock ActivityBar component (not under test)
jest.mock("@/components/ActivityBar", () => {
	const { View } = require("react-native");
	return {
		__esModule: true,
		default: () =>
			require("react").createElement(View, { testID: "activity-bar" }),
	};
});

// Mock MetadataPanel component (not under test)
jest.mock("@/components/MetadataPanel", () => {
	const { View } = require("react-native");
	return {
		__esModule: true,
		default: ({ visible }: { visible: boolean }) =>
			visible
				? require("react").createElement(View, { testID: "metadata-panel" })
				: null,
	};
});

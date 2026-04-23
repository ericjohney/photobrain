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
		const methods = ["onUpdate", "onEnd", "onStart", "minPointers", "numberOfTaps", "maxDuration"];
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
			const { testID, source, ...rest } = props;
			return require("react").createElement(View, {
				testID: testID || "expo-image",
				accessibilityLabel: typeof source?.uri === "string" ? source.uri : undefined,
				...rest,
			});
		},
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
}));

// Mock expo-router
jest.mock("expo-router", () => ({
	useNavigation: () => ({
		setOptions: jest.fn(),
	}),
	useRouter: () => ({
		push: jest.fn(),
		back: jest.fn(),
	}),
}));

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
			require("react").createElement(Text, { ...props, testID: `icon-${name}` }, name),
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
		if (!value) return new Date();
		if (value instanceof Date) return value;
		const parsed = new Date(
			value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"),
		);
		return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
	},
}));

// Mock useJobProgress hook (not under test)
jest.mock("@/hooks/use-job-progress", () => ({
	useJobProgress: () => ({
		progress: null,
		isActive: false,
		isCompleted: false,
		isConnected: false,
		error: null,
	}),
}));

// Mock ActivityBar component (not under test)
jest.mock("@/components/ActivityBar", () => {
	const { View } = require("react-native");
	return {
		__esModule: true,
		default: () => require("react").createElement(View, { testID: "activity-bar" }),
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

import { Image } from "expo-image";
import React from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

/** Clamp scale to [MIN_SCALE, MAX_SCALE]. Exported for testing. */
export function clampScale(value: number): number {
	"worklet";
	return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);
}

/**
 * Clamp translation so the image edge can't move past viewport center.
 * At scale <= 1 (fit-to-screen), no translation is allowed.
 * Exported for testing.
 */
export function clampTranslation(
	value: number,
	dimension: number,
	currentScale: number,
): number {
	"worklet";
	if (currentScale <= 1) return 0;
	const maxTranslate = (dimension * (currentScale - 1)) / 2;
	return Math.min(Math.max(value, -maxTranslate), maxTranslate);
}

interface ZoomablePhotoProps {
	uri: string;
	placeholderUri?: string;
	width: number;
	height: number;
}

export default function ZoomablePhoto({
	uri,
	placeholderUri,
	width,
	height,
}: ZoomablePhotoProps) {
	const scale = useSharedValue(1);
	const savedScale = useSharedValue(1);
	const translateX = useSharedValue(0);
	const translateY = useSharedValue(0);
	const savedTranslateX = useSharedValue(0);
	const savedTranslateY = useSharedValue(0);

	const pinchGesture = Gesture.Pinch()
		.onUpdate((e) => {
			"worklet";
			// Clamp to [1x, 5x] — no rubber-band below fit-to-screen
			scale.value = clampScale(savedScale.value * e.scale);
		})
		.onEnd(() => {
			"worklet";
			scale.value = clampScale(scale.value);
			savedScale.value = scale.value;
			// At 1x, translation resets to center; otherwise clamp to bounds
			translateX.value = clampTranslation(translateX.value, width, scale.value);
			translateY.value = clampTranslation(translateY.value, height, scale.value);
			savedTranslateX.value = translateX.value;
			savedTranslateY.value = translateY.value;
		});

	// Pan uses manualActivation so it only activates when zoomed in.
	// At 1x scale, the gesture fails and the touch passes through to the
	// FlatList's native scroll handler, allowing horizontal swipe-to-page.
	const panGesture = Gesture.Pan()
		.minPointers(1)
		.manualActivation(true)
		.onTouchesMove((_e, stateManager) => {
			"worklet";
			if (scale.value > 1) {
				stateManager.activate();
			} else {
				stateManager.fail();
			}
		})
		.onUpdate((e) => {
			"worklet";
			const newX = savedTranslateX.value + e.translationX;
			const newY = savedTranslateY.value + e.translationY;
			translateX.value = clampTranslation(newX, width, scale.value);
			translateY.value = clampTranslation(newY, height, scale.value);
		})
		.onEnd(() => {
			"worklet";
			savedTranslateX.value = translateX.value;
			savedTranslateY.value = translateY.value;
		});

	const doubleTapGesture = Gesture.Tap()
		.numberOfTaps(2)
		.onEnd(() => {
			"worklet";
			if (scale.value > 1) {
				scale.value = withTiming(MIN_SCALE);
				translateX.value = withTiming(0);
				translateY.value = withTiming(0);
				savedScale.value = MIN_SCALE;
				savedTranslateX.value = 0;
				savedTranslateY.value = 0;
			} else {
				scale.value = withTiming(DOUBLE_TAP_SCALE);
				savedScale.value = DOUBLE_TAP_SCALE;
			}
		});

	const composedGesture = Gesture.Simultaneous(
		doubleTapGesture,
		Gesture.Simultaneous(pinchGesture, panGesture),
	);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
			{ scale: scale.value },
		],
	}));

	return (
		<GestureDetector gesture={composedGesture}>
			<Animated.View
				style={[styles.container, { width, height }, animatedStyle]}
			>
				<Image
					source={{ uri }}
					placeholder={placeholderUri ? { uri: placeholderUri } : undefined}
					style={styles.image}
					contentFit="contain"
					priority="high"
					cachePolicy="memory-disk"
				/>
			</Animated.View>
		</GestureDetector>
	);
}

const styles = StyleSheet.create({
	container: {
		justifyContent: "center",
		alignItems: "center",
	},
	image: {
		width: "100%",
		height: "100%",
	},
});

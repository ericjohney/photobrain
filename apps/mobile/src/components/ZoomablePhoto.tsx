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

	const clampTranslation = (
		value: number,
		dimension: number,
		currentScale: number,
	) => {
		"worklet";
		const maxTranslate = (dimension * (currentScale - 1)) / 2;
		return Math.min(Math.max(value, -maxTranslate), maxTranslate);
	};

	const pinchGesture = Gesture.Pinch()
		.onUpdate((e) => {
			"worklet";
			const newScale = savedScale.value * e.scale;
			scale.value = Math.min(Math.max(newScale, MIN_SCALE * 0.5), MAX_SCALE);
		})
		.onEnd(() => {
			"worklet";
			if (scale.value < MIN_SCALE) {
				scale.value = withTiming(MIN_SCALE);
				translateX.value = withTiming(0);
				translateY.value = withTiming(0);
				savedTranslateX.value = 0;
				savedTranslateY.value = 0;
			} else if (scale.value > MAX_SCALE) {
				scale.value = withTiming(MAX_SCALE);
			}
			savedScale.value = scale.value;
			translateX.value = clampTranslation(
				translateX.value,
				width,
				scale.value,
			);
			translateY.value = clampTranslation(
				translateY.value,
				height,
				scale.value,
			);
			savedTranslateX.value = translateX.value;
			savedTranslateY.value = translateY.value;
		});

	const panGesture = Gesture.Pan()
		.minPointers(1)
		.onUpdate((e) => {
			"worklet";
			if (scale.value <= 1) return;
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

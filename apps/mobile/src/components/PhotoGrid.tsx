import React from "react";
import {
	FlatList,
	StyleSheet,
	Dimensions,
	TouchableOpacity,
	View,
	Text,
} from "react-native";
import { Image } from "expo-image";
import type { PhotoMetadata } from "@photobrain/shared-types";

interface PhotoGridProps {
	photos: PhotoMetadata[];
	onPhotoPress: (photo: PhotoMetadata) => void;
	apiUrl: string;
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const COLUMNS = 3;
const SPACING = 2;
const ITEM_SIZE = (SCREEN_WIDTH - SPACING * (COLUMNS + 1)) / COLUMNS;

export default function PhotoGrid({ photos, onPhotoPress, apiUrl }: PhotoGridProps) {
	if (photos.length === 0) {
		return (
			<View style={styles.emptyContainer}>
				<Text style={styles.emptyText}>No photos found</Text>
			</View>
		);
	}

	return (
		<FlatList
			data={photos}
			keyExtractor={(item) => item.id.toString()}
			numColumns={COLUMNS}
			contentContainerStyle={styles.container}
			renderItem={({ item }) => (
				<TouchableOpacity
					style={styles.photoContainer}
					onPress={() => onPhotoPress(item)}
				>
					<Image
						source={{ uri: `${apiUrl}/api/photos/${item.id}/file` }}
						style={styles.photo}
						contentFit="cover"
						transition={200}
						placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
					/>
				</TouchableOpacity>
			)}
		/>
	);
}

const styles = StyleSheet.create({
	container: {
		padding: SPACING,
	},
	photoContainer: {
		margin: SPACING / 2,
		width: ITEM_SIZE,
		height: ITEM_SIZE,
		borderRadius: 4,
		overflow: "hidden",
		backgroundColor: "#f3f4f6",
	},
	photo: {
		width: "100%",
		height: "100%",
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
	},
	emptyText: {
		fontSize: 16,
		color: "#6b7280",
	},
});

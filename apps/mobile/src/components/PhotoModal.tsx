import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatDate, formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import { Image } from "expo-image";
import React from "react";
import {
	Dimensions,
	Modal,
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface PhotoModalProps {
	visible: boolean;
	photo: PhotoMetadata | null;
	apiUrl: string;
	onClose: () => void;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

export default function PhotoModal({
	visible,
	photo,
	apiUrl,
	onClose,
}: PhotoModalProps) {
	if (!photo) return null;

	return (
		<Modal
			visible={visible}
			transparent={true}
			animationType="fade"
			onRequestClose={onClose}
		>
			<View style={styles.container}>
				<View style={styles.header}>
					<TouchableOpacity onPress={onClose} style={styles.closeButton}>
						<Ionicons name="close" size={28} color="#ffffff" />
					</TouchableOpacity>
				</View>

				<ScrollView
					contentContainerStyle={styles.content}
					maximumZoomScale={3}
					minimumZoomScale={1}
				>
					<Image
						source={{
							uri: `${apiUrl}/api/photos/${photo.id}/thumbnail/medium`,
						}}
						placeholder={{
							uri: `${apiUrl}/api/photos/${photo.id}/thumbnail/tiny`,
						}}
						style={styles.image}
						contentFit="contain"
						priority="high"
						cachePolicy="memory-disk"
					/>

					<View style={styles.infoContainer}>
						<Text style={styles.photoName}>{photo.name}</Text>
						<View style={styles.infoRow}>
							<Text style={styles.infoLabel}>Size:</Text>
							<Text style={styles.infoValue}>{formatFileSize(photo.size)}</Text>
						</View>
						{photo.width && photo.height && (
							<View style={styles.infoRow}>
								<Text style={styles.infoLabel}>Dimensions:</Text>
								<Text style={styles.infoValue}>
									{photo.width} × {photo.height}
								</Text>
							</View>
						)}
						<View style={styles.infoRow}>
							<Text style={styles.infoLabel}>Modified:</Text>
							<Text style={styles.infoValue}>
								{formatDate(photo.modifiedAt)}
							</Text>
						</View>
					</View>
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.95)",
	},
	header: {
		flexDirection: "row",
		justifyContent: "flex-end",
		padding: 16,
		paddingTop: 48,
	},
	closeButton: {
		padding: 8,
	},
	content: {
		alignItems: "center",
	},
	image: {
		width: SCREEN_WIDTH,
		height: SCREEN_HEIGHT * 0.6,
	},
	infoContainer: {
		width: "100%",
		padding: 20,
		backgroundColor: "rgba(0, 0, 0, 0.8)",
	},
	photoName: {
		fontSize: 18,
		fontWeight: "600",
		color: "#ffffff",
		marginBottom: 12,
	},
	infoRow: {
		flexDirection: "row",
		marginBottom: 8,
	},
	infoLabel: {
		fontSize: 14,
		color: "#9ca3af",
		marginRight: 8,
		minWidth: 80,
	},
	infoValue: {
		fontSize: 14,
		color: "#ffffff",
		flex: 1,
	},
});

import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback, useState } from "react";
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { API_URL, thumbnailUrl } from "@/config";
import { useLibraryState } from "@/hooks/use-library-state";
import { trpc } from "@/lib/trpc";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const COLUMNS = 4;
const SPACING = 2;
const ITEM_SIZE = (SCREEN_WIDTH - SPACING * (COLUMNS - 1)) / COLUMNS;

export default function SearchScreen() {
	const colors = useColors();
	const insets = useSafeAreaInsets();
	const [searchQuery, setSearchQuery] = useState("");
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{ enabled: searchQuery.trim().length > 0 },
	);

	const photos = searchPhotosQuery.data?.photos ?? [];
	const library = useLibraryState(photos);

	const handlePhotoPress = useCallback(
		(photo: PhotoMetadata) => {
			Haptics.selectionAsync();
			library.openInLoupe(photo);
		},
		[library],
	);

	const handleLoupeClose = useCallback(() => {
		library.closeLoupe();
	}, [library]);

	const handleLoupeIndexChange = useCallback(
		(index: number) => {
			library.navigateToIndex(index);
		},
		[library],
	);

	const handleShowMetadata = useCallback((photo: PhotoMetadata) => {
		setMetadataPhoto(photo);
	}, []);

	const handleCloseMetadata = useCallback(() => {
		setMetadataPhoto(null);
	}, []);

	if (library.viewMode === "loupe") {
		return (
			<>
				<LoupeView
					photos={photos}
					initialIndex={
						library.activePhotoIndex >= 0 ? library.activePhotoIndex : 0
					}
					apiUrl={API_URL}
					onClose={handleLoupeClose}
					onIndexChange={handleLoupeIndexChange}
					onShowMetadata={handleShowMetadata}
				/>
				<MetadataPanel
					visible={metadataPhoto !== null}
					photo={metadataPhoto}
					apiUrl={API_URL}
					onClose={handleCloseMetadata}
				/>
			</>
		);
	}

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			{/* Search input */}
			<View style={[styles.searchWrapper, { paddingTop: insets.top + 8 }]}>
				<View
					style={[
						styles.searchContainer,
						{
							backgroundColor: colors.muted,
							borderColor: colors.border,
						},
					]}
				>
					<Ionicons
						name="search"
						size={18}
						color={colors.mutedForeground}
					/>
					<TextInput
						style={[styles.searchInput, { color: colors.foreground }]}
						placeholder="Search photos with AI..."
						placeholderTextColor={colors.mutedForeground}
						value={searchQuery}
						onChangeText={setSearchQuery}
						autoCapitalize="none"
						autoCorrect={false}
						returnKeyType="search"
					/>
					{searchQuery.length > 0 && (
						<Pressable onPress={() => setSearchQuery("")}>
							<Ionicons
								name="close-circle"
								size={18}
								color={colors.mutedForeground}
							/>
						</Pressable>
					)}
				</View>
			</View>

			{/* Results */}
			{searchPhotosQuery.isFetching && (
				<View style={styles.loadingContainer}>
					<ActivityIndicator size="large" color={colors.primary} />
				</View>
			)}

			{!searchQuery.trim() && (
				<View style={styles.promptContainer}>
					<Ionicons
						name="sparkles-outline"
						size={48}
						color={colors.mutedForeground}
						style={{ opacity: 0.3 }}
					/>
					<Text
						style={[styles.promptText, { color: colors.mutedForeground }]}
					>
						Search your photos using natural language
					</Text>
					<Text
						style={[styles.promptSubtext, { color: colors.mutedForeground }]}
					>
						Try "sunset on the beach" or "red car"
					</Text>
				</View>
			)}

			{searchQuery.trim().length > 0 &&
				!searchPhotosQuery.isFetching &&
				photos.length === 0 && (
					<View style={styles.promptContainer}>
						<Ionicons
							name="search-outline"
							size={48}
							color={colors.mutedForeground}
							style={{ opacity: 0.3 }}
						/>
						<Text
							style={[styles.promptText, { color: colors.mutedForeground }]}
						>
							No results found
						</Text>
					</View>
				)}

			{photos.length > 0 && (
				<FlatList
					data={photos}
					keyExtractor={(item) => item.id.toString()}
					numColumns={COLUMNS}
					columnWrapperStyle={styles.photoRow}
					renderItem={({ item }) => (
						<Pressable
							onPress={() => handlePhotoPress(item)}
							style={[
								styles.photoContainer,
								{ backgroundColor: colors.muted },
							]}
						>
							<Image
								source={{
									uri: thumbnailUrl(item.id, "tiny", item.thumbnailUpdatedAt),
								}}
								style={styles.photo}
								contentFit="cover"
								transition={150}
								cachePolicy="memory-disk"
							/>
						</Pressable>
					)}
					initialNumToRender={20}
					contentContainerStyle={styles.gridContent}
				/>
			)}

			<MetadataPanel
				visible={metadataPhoto !== null}
				photo={metadataPhoto}
				apiUrl={API_URL}
				onClose={handleCloseMetadata}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	searchWrapper: {
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	searchContainer: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		height: 44,
		borderRadius: 22,
		gap: 10,
		borderWidth: 0.5,
	},
	searchInput: {
		flex: 1,
		fontSize: 16,
		height: "100%",
	},
	loadingContainer: {
		paddingTop: 48,
		alignItems: "center",
	},
	promptContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
		gap: 10,
		marginTop: -60,
	},
	promptText: {
		fontSize: 16,
		fontWeight: "500",
		textAlign: "center",
	},
	promptSubtext: {
		fontSize: 14,
		textAlign: "center",
		opacity: 0.7,
	},
	gridContent: {
		paddingTop: 4,
	},
	photoRow: {
		gap: SPACING,
	},
	photoContainer: {
		width: ITEM_SIZE,
		height: ITEM_SIZE,
		overflow: "hidden",
	},
	photo: {
		width: "100%",
		height: "100%",
	},
});

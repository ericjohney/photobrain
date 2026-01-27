import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import React, { useCallback, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import ActivityBar from "@/components/ActivityBar";
import Filmstrip from "@/components/Filmstrip";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import PhotoGrid from "@/components/PhotoGrid";
import SearchBar from "@/components/SearchBar";
import { API_URL } from "@/config";
import { useLibraryState } from "@/hooks/use-library-state";
import { useTaskProgress } from "@/hooks/use-task-progress";
import { trpc } from "@/lib/trpc";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export default function DashboardScreen() {
	const colors = useColors();
	const [searchQuery, setSearchQuery] = useState("");
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);

	// tRPC queries
	const photosQuery = trpc.photos.useQuery(undefined, {
		enabled: !searchQuery.trim(),
	});

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{
			enabled: searchQuery.trim().length > 0,
		},
	);

	const scanMutation = trpc.scan.useMutation({
		onSuccess: () => {
			photosQuery.refetch();
		},
		onError: (err) => {
			console.error("Scan error:", err.message);
		},
	});

	// Task progress tracking
	const taskProgress = useTaskProgress();

	// Determine which data to display
	const isSearching = searchQuery.trim().length > 0;
	const activeQuery = isSearching ? searchPhotosQuery : photosQuery;
	const photos = activeQuery.data?.photos ?? [];
	const loading = activeQuery.isLoading;
	const error = activeQuery.error?.message ?? null;

	// Library state for selection and view mode
	const library = useLibraryState(photos);

	// Handlers
	const handleScan = useCallback(() => {
		scanMutation.mutate();
	}, [scanMutation]);

	const handleSearchChange = useCallback((text: string) => {
		setSearchQuery(text);
	}, []);

	const handleSearchClear = useCallback(() => {
		setSearchQuery("");
	}, []);

	const handleRefresh = useCallback(() => {
		activeQuery.refetch();
	}, [activeQuery]);

	const handlePhotoPress = useCallback(
		(photo: PhotoMetadata) => {
			library.selectPhoto(photo);
		},
		[library],
	);

	const handlePhotoLongPress = useCallback(
		(photo: PhotoMetadata) => {
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

	const handleFilmstripPress = useCallback(
		(photo: PhotoMetadata) => {
			library.selectPhoto(photo);
		},
		[library],
	);

	const handleShowMetadata = useCallback((photo: PhotoMetadata) => {
		setMetadataPhoto(photo);
	}, []);

	const handleCloseMetadata = useCallback(() => {
		setMetadataPhoto(null);
	}, []);

	// Loading state
	if (loading && !library.isLoaded) {
		return (
			<View
				style={[styles.centerContainer, { backgroundColor: colors.background }]}
			>
				<ActivityIndicator size="large" color={colors.primary} />
				<Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
					Loading photos...
				</Text>
			</View>
		);
	}

	// Loupe view (full screen)
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

	// Grid view
	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			{/* Header with search and actions */}
			<View style={[styles.header, { backgroundColor: colors.toolbar }]}>
				<SearchBar
					value={searchQuery}
					onChangeText={handleSearchChange}
					onClear={handleSearchClear}
					loading={searchPhotosQuery.isFetching}
				/>
				<View style={styles.actions}>
					<View style={styles.photoCount}>
						<Text
							style={[styles.photoCountText, { color: colors.mutedForeground }]}
						>
							{photos.length} photos
							{library.selectedCount > 0 &&
								` (${library.selectedCount} selected)`}
						</Text>
					</View>
					<Pressable
						style={[styles.scanButton, { backgroundColor: colors.primary }]}
						onPress={handleScan}
						disabled={scanMutation.isPending || taskProgress.hasActiveJobs}
					>
						{scanMutation.isPending || taskProgress.hasActiveJobs ? (
							<ActivityIndicator size="small" color="#ffffff" />
						) : (
							<>
								<Ionicons name="refresh" size={18} color="#ffffff" />
								<Text style={styles.scanButtonText}>Scan</Text>
							</>
						)}
					</Pressable>
				</View>
			</View>

			{/* Activity/Progress bar */}
			<ActivityBar
				scanProgress={taskProgress.scanProgress}
				embeddingProgress={taskProgress.embeddingProgress}
				hasActiveJobs={taskProgress.hasActiveJobs}
			/>

			{/* Error display */}
			{error && (
				<View
					style={[
						styles.errorContainer,
						{ backgroundColor: `${colors.destructive}15` },
					]}
				>
					<Ionicons name="alert-circle" size={20} color={colors.destructive} />
					<Text style={[styles.errorText, { color: colors.destructive }]}>
						{error}
					</Text>
				</View>
			)}

			{/* Photo grid */}
			<View style={styles.content}>
				{loading ? (
					<ScrollView
						refreshControl={
							<RefreshControl
								refreshing={activeQuery.isFetching}
								onRefresh={handleRefresh}
								tintColor={colors.primary}
							/>
						}
						contentContainerStyle={styles.loadingContainer}
					>
						<ActivityIndicator size="large" color={colors.primary} />
					</ScrollView>
				) : (
					<PhotoGrid
						photos={photos}
						selectedPhotos={library.selectedPhotos}
						activePhotoId={library.activePhoto?.id}
						onPhotoPress={handlePhotoPress}
						onPhotoLongPress={handlePhotoLongPress}
						apiUrl={API_URL}
					/>
				)}
			</View>

			{/* Filmstrip when a photo is selected */}
			{library.activePhoto && photos.length > 1 && (
				<Filmstrip
					photos={photos}
					activePhotoId={library.activePhoto.id}
					selectedPhotos={library.selectedPhotos}
					apiUrl={API_URL}
					onPhotoPress={handleFilmstripPress}
				/>
			)}

			{/* Metadata panel */}
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
	header: {
		borderBottomWidth: 1,
		borderBottomColor: "rgba(0,0,0,0.1)",
	},
	actions: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		padding: 12,
		paddingTop: 0,
	},
	photoCount: {
		flex: 1,
	},
	photoCountText: {
		fontSize: 13,
	},
	scanButton: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 14,
		paddingVertical: 8,
		borderRadius: 6,
		gap: 6,
	},
	scanButtonText: {
		color: "#ffffff",
		fontSize: 14,
		fontWeight: "600",
	},
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	loadingText: {
		marginTop: 12,
		fontSize: 16,
	},
	loadingContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	content: {
		flex: 1,
	},
	errorContainer: {
		flexDirection: "row",
		alignItems: "center",
		padding: 12,
		gap: 8,
	},
	errorText: {
		flex: 1,
		fontSize: 14,
	},
});

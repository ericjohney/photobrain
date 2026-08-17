import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { useIsFocused } from "@react-navigation/native";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Modal,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";
import GlassSurface from "@/components/GlassSurface";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { thumbnailUrl } from "@/config";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLibraryState } from "@/hooks/use-library-state";
import { trpc } from "@/lib/trpc";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SearchPhoto = RouterOutputs["searchPhotos"]["photos"][number];

const GRID_SPACING = 1;

export default function SearchScreen() {
	const colors = useColors();
	const insets = useSafeAreaInsets();
	const { width } = useWindowDimensions();
	const columns = width >= 1024 ? 8 : width >= 768 ? 7 : width >= 560 ? 5 : 4;
	const itemSize = (width - GRID_SPACING * (columns - 1)) / columns;
	const [searchQuery, setSearchQuery] = useState("");
	const [metadataPhoto, setMetadataPhoto] = useState<SearchPhoto | null>(null);
	const searchBarRef = useRef<SearchBarCommands>(null);
	const debouncedQuery = useDebouncedValue(searchQuery.trim(), 350);
	const isFocused = useIsFocused();
	const utils = trpc.useUtils();

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: debouncedQuery, limit: 50 },
		{
			enabled: isFocused && debouncedQuery.length > 0,
			trpc: { abortOnUnmount: true },
		},
	);
	const photos = searchPhotosQuery.data?.photos ?? [];
	const hasSearchData = searchPhotosQuery.data !== undefined;
	const library = useLibraryState(photos);
	const isDebouncing = searchQuery.trim() !== debouncedQuery;
	const isSearching =
		isDebouncing || (searchPhotosQuery.isFetching && !hasSearchData);
	const cancelSearch = useCallback(() => {
		void utils.searchPhotos.cancel();
	}, [utils.searchPhotos]);

	useEffect(() => {
		if (!isFocused) cancelSearch();
	}, [cancelSearch, isFocused]);

	const handlePhotoPress = useCallback(
		(photo: SearchPhoto) => {
			void Haptics.selectionAsync();
			library.openInLoupe(photo);
		},
		[library],
	);

	const clearSearch = useCallback(() => {
		cancelSearch();
		setSearchQuery("");
		searchBarRef.current?.clearText();
	}, [cancelSearch]);
	const applyExample = useCallback(
		(query: string) => {
			cancelSearch();
			setSearchQuery(query);
			searchBarRef.current?.setText(query);
		},
		[cancelSearch],
	);

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			<Stack.Screen options={{ title: "Search", headerLargeTitle: true }} />
			{Platform.OS === "ios" && (
				<Stack.SearchBar
					ref={searchBarRef}
					placeholder="Search Photos"
					autoCapitalize="none"
					hideWhenScrolling={false}
					onChangeText={(event) => setSearchQuery(event.nativeEvent.text)}
					onCancelButtonPress={clearSearch}
					onClose={clearSearch}
				/>
			)}

			{Platform.OS !== "ios" && (
				<View style={[styles.searchHeader, { paddingTop: insets.top + 12 }]}>
					<GlassSurface style={styles.searchField} glassEffectStyle="clear">
						<Ionicons name="search" size={18} color={colors.mutedForeground} />
						<TextInput
							accessibilityLabel="Search photos"
							style={[styles.searchInput, { color: colors.foreground }]}
							placeholder="Search Photos"
							placeholderTextColor={colors.mutedForeground}
							value={searchQuery}
							onChangeText={setSearchQuery}
							autoCapitalize="none"
							returnKeyType="search"
						/>
						{searchQuery.length > 0 && (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Clear search"
								onPress={clearSearch}
								style={styles.clearButton}
							>
								<Ionicons
									name="close-circle"
									size={18}
									color={colors.mutedForeground}
								/>
							</Pressable>
						)}
					</GlassSurface>
				</View>
			)}

			{isSearching && searchQuery.trim().length > 0 && (
				<View style={styles.statusRow}>
					<ActivityIndicator size="small" color={colors.primary} />
					<Text style={[styles.statusText, { color: colors.mutedForeground }]}>
						Searching...
					</Text>
				</View>
			)}

			{searchPhotosQuery.isError && !hasSearchData && !isSearching && (
				<View style={styles.messageContainer}>
					<Ionicons
						name="cloud-offline-outline"
						size={42}
						color={colors.mutedForeground}
					/>
					<Text style={[styles.messageTitle, { color: colors.foreground }]}>
						Search unavailable
					</Text>
					<Text style={[styles.messageBody, { color: colors.mutedForeground }]}>
						Check your connection and try again.
					</Text>
					<Pressable
						accessibilityRole="button"
						onPress={() => searchPhotosQuery.refetch()}
						style={[styles.retryButton, { backgroundColor: colors.primary }]}
					>
						<Text style={styles.retryText}>Try Again</Text>
					</Pressable>
				</View>
			)}

			{searchQuery.trim().length === 0 && (
				<View style={styles.messageContainer}>
					<Ionicons name="sparkles-outline" size={44} color={colors.primary} />
					<Text style={[styles.messageTitle, { color: colors.foreground }]}>
						Search your library
					</Text>
					<Text style={[styles.messageBody, { color: colors.mutedForeground }]}>
						Describe a place, subject, color, or moment. PhotoBrain searches by
						visual meaning.
					</Text>
					<View style={styles.examples}>
						{["sunset on the beach", "red car", "mountains in winter"].map(
							(example) => (
								<Pressable
									key={example}
									onPress={() => applyExample(example)}
									style={[
										styles.exampleChip,
										{ backgroundColor: colors.muted },
									]}
								>
									<Text
										style={[styles.exampleText, { color: colors.foreground }]}
									>
										{example}
									</Text>
								</Pressable>
							),
						)}
					</View>
				</View>
			)}

			{debouncedQuery.length > 0 &&
				!isSearching &&
				hasSearchData &&
				photos.length === 0 && (
					<View style={styles.messageContainer}>
						<Ionicons
							name="search-outline"
							size={44}
							color={colors.mutedForeground}
						/>
						<Text style={[styles.messageTitle, { color: colors.foreground }]}>
							No results
						</Text>
						<Text
							style={[styles.messageBody, { color: colors.mutedForeground }]}
						>
							Try a broader description or a different phrase.
						</Text>
					</View>
				)}

			{photos.length > 0 && !isSearching && (
				<FlatList
					data={photos}
					key={columns}
					keyExtractor={(photo) => photo.id.toString()}
					numColumns={columns}
					columnWrapperStyle={styles.photoRow}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={styles.results}
					renderItem={({ item }) => (
						<Pressable
							testID={`search-result-${item.id}`}
							accessibilityRole="button"
							accessibilityLabel={`Open ${item.name}`}
							onPress={() => handlePhotoPress(item)}
							style={{
								width: itemSize,
								height: itemSize,
								backgroundColor: colors.muted,
							}}
						>
							<Image
								source={{
									uri: thumbnailUrl(item.id, "tiny", item.thumbnailUpdatedAt),
								}}
								style={styles.photo}
								contentFit="cover"
								transition={120}
								cachePolicy="memory-disk"
								accessibilityIgnoresInvertColors
							/>
						</Pressable>
					)}
					initialNumToRender={24}
					maxToRenderPerBatch={16}
					windowSize={7}
				/>
			)}

			<Modal
				visible={library.viewMode === "loupe"}
				animationType="none"
				statusBarTranslucent
				supportedOrientations={["portrait", "landscape"]}
				onRequestClose={library.closeLoupe}
			>
				<GestureHandlerRootView style={styles.loupeRoot}>
					<LoupeView
						key={library.loupeSession}
						photos={photos}
						initialIndex={Math.max(library.activePhotoIndex, 0)}
						onClose={library.closeLoupe}
						onIndexChange={library.navigateToIndex}
						onShowMetadata={setMetadataPhoto}
					/>
					<MetadataPanel
						visible={metadataPhoto !== null}
						photo={metadataPhoto}
						onClose={() => setMetadataPhoto(null)}
					/>
				</GestureHandlerRootView>
			</Modal>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	loupeRoot: { flex: 1 },
	searchHeader: { paddingHorizontal: 16, paddingBottom: 10 },
	searchField: {
		height: 44,
		borderRadius: 22,
		borderCurve: "continuous",
		paddingHorizontal: 13,
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
	},
	searchInput: { flex: 1, height: "100%", fontSize: 16 },
	clearButton: {
		width: 32,
		height: 32,
		alignItems: "center",
		justifyContent: "center",
	},
	statusRow: {
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: 8,
		paddingVertical: 12,
	},
	statusText: { fontSize: 13, fontWeight: "500" },
	messageContainer: {
		flex: 1,
		minHeight: 420,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 34,
	},
	messageTitle: {
		marginTop: 15,
		fontSize: 21,
		fontWeight: "700",
		letterSpacing: -0.3,
		textAlign: "center",
	},
	messageBody: {
		marginTop: 7,
		maxWidth: 340,
		fontSize: 15,
		lineHeight: 21,
		textAlign: "center",
	},
	examples: { marginTop: 22, alignItems: "center", gap: 8 },
	exampleChip: {
		paddingHorizontal: 13,
		paddingVertical: 8,
		borderRadius: 17,
		borderCurve: "continuous",
	},
	exampleText: { fontSize: 13, fontWeight: "500" },
	retryButton: {
		marginTop: 18,
		paddingHorizontal: 18,
		paddingVertical: 9,
		borderRadius: 18,
	},
	retryText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
	results: { paddingTop: 4 },
	photoRow: { gap: GRID_SPACING, marginBottom: GRID_SPACING },
	photo: { width: "100%", height: "100%" },
});

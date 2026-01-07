import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import React, { useState } from "react";
import {
	ActivityIndicator,
	Alert,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import PhotoGrid from "@/components/PhotoGrid";
import PhotoModal from "@/components/PhotoModal";
import SearchBar from "@/components/SearchBar";
import { API_URL } from "@/config";
import { trpc } from "@/lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export default function DashboardScreen() {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(
		null,
	);

	// Use tRPC hooks
	const photosQuery = trpc.photos.useQuery(undefined, {
		enabled: !searchQuery.trim(),
	});

	const searchQuery$ = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{
			enabled: searchQuery.trim().length > 0,
		},
	);

	const scanMutation = trpc.scan.useMutation({
		onSuccess: (result) => {
			Alert.alert(
				"Scan Complete",
				`Scanned: ${result.scanned}\nInserted: ${result.inserted}\nSkipped: ${result.skipped}\nDuration: ${result.duration.toFixed(2)}s`,
			);
			photosQuery.refetch();
		},
		onError: (err) => {
			Alert.alert("Scan Error", err.message);
		},
	});

	// Determine which data to display
	const isSearching = searchQuery.trim().length > 0;
	const activeQuery = isSearching ? searchQuery$ : photosQuery;
	const photos = activeQuery.data?.photos ?? [];
	const loading = activeQuery.isLoading;
	const error = activeQuery.error?.message ?? null;

	const handleScan = () => {
		scanMutation.mutate();
	};

	const handleSearchChange = (text: string) => {
		setSearchQuery(text);
	};

	const handleSearchClear = () => {
		setSearchQuery("");
	};

	const handleRefresh = () => {
		activeQuery.refetch();
	};

	if (loading) {
		return (
			<View style={styles.centerContainer}>
				<ActivityIndicator size="large" color="#3b82f6" />
				<Text style={styles.loadingText}>Loading photos...</Text>
			</View>
		);
	}

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<SearchBar
					value={searchQuery}
					onChangeText={handleSearchChange}
					onClear={handleSearchClear}
					loading={searchQuery$.isFetching}
				/>
				<View style={styles.actions}>
					<TouchableOpacity
						style={styles.scanButton}
						onPress={handleScan}
						disabled={scanMutation.isPending}
					>
						{scanMutation.isPending ? (
							<ActivityIndicator size="small" color="#ffffff" />
						) : (
							<>
								<Ionicons name="refresh" size={20} color="#ffffff" />
								<Text style={styles.scanButtonText}>Scan</Text>
							</>
						)}
					</TouchableOpacity>
				</View>
			</View>

			{error && (
				<View style={styles.errorContainer}>
					<Ionicons name="alert-circle" size={20} color="#ef4444" />
					<Text style={styles.errorText}>{error}</Text>
				</View>
			)}

			<ScrollView
				style={styles.content}
				refreshControl={
					<RefreshControl
						refreshing={activeQuery.isFetching}
						onRefresh={handleRefresh}
					/>
				}
			>
				<PhotoGrid
					photos={photos}
					onPhotoPress={setSelectedPhoto}
					apiUrl={API_URL}
				/>
			</ScrollView>

			<PhotoModal
				visible={selectedPhoto !== null}
				photo={selectedPhoto}
				apiUrl={API_URL}
				onClose={() => setSelectedPhoto(null)}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#ffffff",
	},
	header: {
		backgroundColor: "#ffffff",
		borderBottomWidth: 1,
		borderBottomColor: "#e5e7eb",
	},
	actions: {
		flexDirection: "row",
		justifyContent: "flex-end",
		padding: 12,
		paddingTop: 0,
	},
	scanButton: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#3b82f6",
		paddingHorizontal: 16,
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
		backgroundColor: "#ffffff",
	},
	loadingText: {
		marginTop: 12,
		fontSize: 16,
		color: "#6b7280",
	},
	content: {
		flex: 1,
	},
	errorContainer: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#fee2e2",
		padding: 12,
		gap: 8,
	},
	errorText: {
		flex: 1,
		color: "#991b1b",
		fontSize: 14,
	},
});

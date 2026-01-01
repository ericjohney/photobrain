import React, { useState, useEffect, useCallback } from "react";
import {
	View,
	StyleSheet,
	ActivityIndicator,
	Text,
	TouchableOpacity,
	Alert,
	RefreshControl,
	ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { trpc } from "../lib/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@photobrain/api/src/trpc/router";
import { debounce } from "@photobrain/utils";
import { API_URL } from "../config";
import PhotoGrid from "../components/PhotoGrid";
import SearchBar from "../components/SearchBar";
import PhotoModal from "../components/PhotoModal";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export default function DashboardScreen() {
	const [photos, setPhotos] = useState<PhotoMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadPhotos = async () => {
		try {
			setError(null);
			const response = await client.getPhotos();
			setPhotos(response.photos);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to load photos";
			setError(errorMessage);
			Alert.alert("Error", errorMessage);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	};

	const searchPhotos = useCallback(
		debounce(async (query: string) => {
			if (!query.trim()) {
				loadPhotos();
				return;
			}

			try {
				setSearching(true);
				setError(null);
				const response = await client.searchPhotos({ query, limit: 50 });
				setPhotos(response.photos);
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : "Search failed";
				setError(errorMessage);
				Alert.alert("Search Error", errorMessage);
			} finally {
				setSearching(false);
			}
		}, 500),
		[]
	);

	const handleScan = async () => {
		try {
			setScanning(true);
			const result = await client.scan();
			Alert.alert(
				"Scan Complete",
				`Scanned: ${result.scanned}\nInserted: ${result.inserted}\nSkipped: ${result.skipped}\nDuration: ${result.duration.toFixed(2)}s`
			);
			loadPhotos();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Scan failed";
			Alert.alert("Scan Error", errorMessage);
		} finally {
			setScanning(false);
		}
	};

	const handleSearchChange = (text: string) => {
		setSearchQuery(text);
		searchPhotos(text);
	};

	const handleSearchClear = () => {
		setSearchQuery("");
		loadPhotos();
	};

	const handleRefresh = () => {
		setRefreshing(true);
		if (searchQuery.trim()) {
			searchPhotos(searchQuery);
		} else {
			loadPhotos();
		}
	};

	useEffect(() => {
		loadPhotos();
	}, []);

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
					loading={searching}
				/>
				<View style={styles.actions}>
					<TouchableOpacity
						style={styles.scanButton}
						onPress={handleScan}
						disabled={scanning}
					>
						{scanning ? (
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
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
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

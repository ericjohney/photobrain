import { useState, useEffect } from "react";
import { PhotoGrid } from "@/components/PhotoGrid";
import { SearchBar } from "@/components/SearchBar";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/Layout";
import { RefreshCw, Loader2 } from "lucide-react";
import { PhotoBrainClient, type PhotosResponse } from "@photobrain/api-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";
const client = new PhotoBrainClient(API_URL);

export function Dashboard() {
	const [photos, setPhotos] = useState<PhotosResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [scanning, setScanning] = useState(false);

	const fetchPhotos = async (query?: string) => {
		setLoading(true);
		setError(null);

		try {
			// Use semantic search if there's a query, otherwise get all photos
			const data = query
				? await client.searchPhotos({ query })
				: await client.getPhotos();

			setPhotos(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load photos");
			console.error("Error fetching photos:", err);
		} finally {
			setLoading(false);
		}
	};

	const handleScan = async () => {
		setScanning(true);
		setError(null);

		try {
			const result = await client.scan();
			console.log("Scan result:", result);

			// After scanning, fetch the updated photos
			await fetchPhotos(searchQuery);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to scan photos");
			console.error("Error scanning photos:", err);
		} finally {
			setScanning(false);
		}
	};

	useEffect(() => {
		fetchPhotos();
	}, []);

	const handleSearch = () => {
		fetchPhotos(searchQuery);
	};

	const handleRefresh = () => {
		setSearchQuery("");
		handleScan();
	};

	return (
		<Layout
			title="Gallery"
			actions={
				<>
					<SearchBar
						value={searchQuery}
						onChange={setSearchQuery}
						onSearch={handleSearch}
					/>
					<Button
						variant="outline"
						size="icon"
						onClick={handleRefresh}
						disabled={loading || scanning}
						title="Scan directory for new photos"
					>
						<RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />
					</Button>
				</>
			}
		>
			{loading && (
				<div className="flex flex-col items-center justify-center py-20">
					<Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
					<p className="text-muted-foreground">Loading photos...</p>
				</div>
			)}

			{error && (
				<div className="flex flex-col items-center justify-center py-20">
					<div className="bg-destructive/10 text-destructive px-6 py-4 rounded-lg border border-destructive/20">
						<p className="font-medium">Error loading photos</p>
						<p className="text-sm">{error}</p>
						<Button
							variant="outline"
							size="sm"
							onClick={handleRefresh}
							className="mt-4"
						>
							Try again
						</Button>
					</div>
				</div>
			)}

			{!loading && !error && photos && (
				<>
					{searchQuery && (
						<div className="mb-4 text-sm text-muted-foreground">
							Found {photos.total} result{photos.total !== 1 ? "s" : ""} for "
							{searchQuery}" using semantic search
						</div>
					)}
					<PhotoGrid photos={photos.photos} />
				</>
			)}
		</Layout>
	);
}

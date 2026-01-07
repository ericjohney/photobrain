import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Layout } from "@/components/Layout";
import { PhotoGrid } from "@/components/PhotoGrid";
import { SearchBar } from "@/components/SearchBar";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

export function Dashboard() {
	const [searchQuery, setSearchQuery] = useState("");

	// Use tRPC queries
	const photosQuery = trpc.photos.useQuery(undefined, {
		enabled: !searchQuery,
	});

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{ enabled: !!searchQuery },
	);

	const scanMutation = trpc.scan.useMutation({
		onSuccess: (result) => {
			console.log("Scan result:", result);
			// Refetch photos after scan
			photosQuery.refetch();
			if (searchQuery) {
				searchPhotosQuery.refetch();
			}
		},
	});

	// Determine which data to use
	const photos = searchQuery ? searchPhotosQuery.data : photosQuery.data;
	const loading = searchQuery
		? searchPhotosQuery.isLoading
		: photosQuery.isLoading;
	const error = searchQuery ? searchPhotosQuery.error : photosQuery.error;

	const handleSearch = () => {
		// Search is handled automatically by the query
	};

	const handleRefresh = () => {
		setSearchQuery("");
		scanMutation.mutate();
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
						disabled={loading || scanMutation.isPending}
						title="Scan directory for new photos"
					>
						<RefreshCw
							className={`h-4 w-4 ${scanMutation.isPending ? "animate-spin" : ""}`}
						/>
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
						<p className="text-sm">{error.message}</p>
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

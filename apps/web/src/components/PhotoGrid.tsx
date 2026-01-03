import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Lightbox } from "@/components/Lightbox";
import { config } from "@/lib/config";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { formatFileSize } from "@photobrain/utils";

// Infer types from tRPC router
type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface PhotoGridProps {
	photos: PhotoMetadata[];
}

export function PhotoGrid({ photos }: PhotoGridProps) {
	const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(
		null,
	);

	const getImageUrl = (photo: PhotoMetadata) => {
		return `${config.apiUrl}/api/photos/${photo.id}/file`;
	};

	return (
		<>
			<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
				{photos.map((photo) => (
					<Card
						key={photo.id}
						className="group relative overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:scale-[1.02]"
						onClick={() => setSelectedPhoto(photo)}
					>
						<div className="aspect-square relative bg-muted">
							<img
								src={getImageUrl(photo)}
								alt={photo.name}
								className="w-full h-full object-cover"
								loading="lazy"
							/>
							<div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
						</div>
						<div className="p-2 bg-card">
							<p className="text-xs font-medium truncate" title={photo.name}>
								{photo.name}
							</p>
							<p className="text-xs text-muted-foreground">
								{formatFileSize(photo.size)}
							</p>
						</div>
					</Card>
				))}
			</div>

			{photos.length === 0 && (
				<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
					<ImageIcon className="w-16 h-16 mb-4 opacity-20" />
					<p className="text-lg font-medium">No photos found</p>
					<p className="text-sm">
						Try adjusting your search or add some photos
					</p>
				</div>
			)}

			{selectedPhoto && (
				<Lightbox
					photo={selectedPhoto}
					onClose={() => setSelectedPhoto(null)}
				/>
			)}
		</>
	);
}

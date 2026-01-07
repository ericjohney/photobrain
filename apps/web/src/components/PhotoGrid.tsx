import type { AppRouter } from "@photobrain/api";
import { formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import { AlertCircle, Camera, ImageIcon } from "lucide-react";
import { useState } from "react";
import { Lightbox } from "@/components/Lightbox";
import { Card } from "@/components/ui/card";
import { getThumbnailUrl } from "@/lib/thumbnails";

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
							{/* Show placeholder for failed RAW conversions */}
							{photo.isRaw && photo.rawStatus !== "converted" ? (
								<div className="w-full h-full flex flex-col items-center justify-center bg-gray-800 text-gray-400">
									<Camera className="w-12 h-12 mb-2 opacity-50" />
									<span className="text-xs">
										{photo.rawStatus === "no_converter"
											? "No Converter"
											: "Conversion Failed"}
									</span>
								</div>
							) : (
								<img
									src={getThumbnailUrl(photo.id, "tiny")}
									alt={photo.name}
									className="w-full h-full object-cover"
									loading="lazy"
								/>
							)}
							<div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />

							{/* RAW badge */}
							{photo.isRaw && (
								<div className="absolute top-2 left-2 bg-orange-500 text-white text-[10px] px-1.5 py-0.5 rounded font-semibold">
									{photo.rawFormat || "RAW"}
								</div>
							)}

							{/* Failed indicator */}
							{photo.isRaw && photo.rawStatus === "failed" && (
								<div className="absolute top-2 right-2">
									<AlertCircle className="w-4 h-4 text-red-500" />
								</div>
							)}
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

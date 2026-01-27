import { AlertCircle, Camera, ImageIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getThumbnailSrcSet, getThumbnailUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PhotoGridProps {
	photos: PhotoMetadata[];
	selectedPhotos?: Set<number>;
	activePhotoId?: number | null;
	thumbnailSize?: number;
	onPhotoClick?: (photo: PhotoMetadata, event: React.MouseEvent) => void;
	onPhotoDoubleClick?: (photo: PhotoMetadata) => void;
	className?: string;
}

export function PhotoGrid({
	photos,
	selectedPhotos = new Set(),
	activePhotoId = null,
	thumbnailSize = 200,
	onPhotoClick,
	onPhotoDoubleClick,
	className,
}: PhotoGridProps) {
	const handleClick = useCallback(
		(photo: PhotoMetadata, event: React.MouseEvent) => {
			onPhotoClick?.(photo, event);
		},
		[onPhotoClick],
	);

	const handleDoubleClick = useCallback(
		(photo: PhotoMetadata) => {
			onPhotoDoubleClick?.(photo);
		},
		[onPhotoDoubleClick],
	);

	// Calculate grid columns based on thumbnail size
	const gridStyle = useMemo(
		() => ({
			gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))`,
			gap: "2px",
		}),
		[thumbnailSize],
	);

	if (photos.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted-foreground">
				<ImageIcon className="h-16 w-16 mb-4 opacity-20" />
				<p className="text-sm font-medium">No photos found</p>
				<p className="text-xs">Try adjusting your search or add some photos</p>
			</div>
		);
	}

	return (
		<ScrollArea className={cn("h-full", className)}>
			<div className="p-1">
				<div className="grid" style={gridStyle}>
					{photos.map((photo) => {
						const isSelected = selectedPhotos.has(photo.id);
						const isActive = activePhotoId === photo.id;
						const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";

						return (
							<div
								key={photo.id}
								className={cn(
									"group relative aspect-square cursor-pointer overflow-hidden bg-muted",
									"transition-all duration-75",
									"ring-inset",
									isSelected && "ring-2 ring-selection",
									isActive && "ring-2 ring-selection brightness-110",
									!isSelected &&
										!isActive &&
										"hover:ring-1 hover:ring-thumbnail-border",
								)}
								onClick={(e) => handleClick(photo, e)}
								onDoubleClick={() => handleDoubleClick(photo)}
							>
								{/* Thumbnail */}
								{isFailedRaw ? (
									<div className="flex h-full w-full flex-col items-center justify-center bg-muted text-muted-foreground">
										<Camera className="h-8 w-8 mb-1 opacity-50" />
										<span className="text-2xs">
											{photo.rawStatus === "no_converter"
												? "No Converter"
												: "Failed"}
										</span>
									</div>
								) : (
									<img
										src={getThumbnailUrl(photo.id, "small")}
										srcSet={getThumbnailSrcSet(photo.id)}
										sizes={`${thumbnailSize}px`}
										alt={photo.name}
										className="h-full w-full object-cover"
										loading="lazy"
										draggable={false}
									/>
								)}

								{/* Hover overlay - pointer-events-none to not block clicks */}
								<div
									className={cn(
										"absolute inset-0 transition-colors pointer-events-none",
										"group-hover:bg-black/10",
										isSelected && "bg-selection/10",
									)}
								/>

								{/* RAW badge */}
								{photo.isRaw && (
									<div className="absolute left-1 top-1 rounded bg-orange-500/90 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm">
										{photo.rawFormat || "RAW"}
									</div>
								)}

								{/* Failed indicator */}
								{photo.isRaw && photo.rawStatus === "failed" && (
									<div className="absolute right-1 top-1">
										<AlertCircle className="h-3.5 w-3.5 text-red-500 drop-shadow" />
									</div>
								)}

								{/* Filename on hover */}
								<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100">
									<p className="truncate text-2xs font-medium text-white">
										{photo.name}
									</p>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</ScrollArea>
	);
}

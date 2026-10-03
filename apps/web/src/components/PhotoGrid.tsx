import { AlertCircle, Camera, Flag, ImageIcon, Star, X } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getThumbnailSrcSet, getThumbnailUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PhotoGridProps<T extends PhotoMetadata> {
	photos: T[];
	activePhotoId?: number | null;
	thumbnailSize?: number;
	onPhotoClick?: (photo: T) => void;
	onPhotoDoubleClick?: (photo: T) => void;
	/** Optional per-photo label shown as a badge (e.g. a review reason). */
	badgeLabel?: (photo: T) => string | undefined;
	className?: string;
}

export function PhotoGrid<T extends PhotoMetadata>({
	photos,
	activePhotoId = null,
	thumbnailSize = 200,
	onPhotoClick,
	onPhotoDoubleClick,
	badgeLabel,
	className,
}: PhotoGridProps<T>) {
	const handleClick = useCallback(
		(photo: T) => {
			onPhotoClick?.(photo);
		},
		[onPhotoClick],
	);

	const handleDoubleClick = useCallback(
		(photo: T) => {
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
			<div
				data-testid="photo-grid-empty"
				className="flex h-full flex-col items-center justify-center text-muted-foreground"
			>
				<ImageIcon className="h-16 w-16 mb-4 opacity-20" />
				<p className="text-sm font-medium">No photos found</p>
				<p className="text-xs">Try adjusting your search or add some photos</p>
			</div>
		);
	}

	return (
		<ScrollArea className={cn("h-full", className)}>
			<div className="p-1">
				<div data-testid="photo-grid" className="grid" style={gridStyle}>
					{photos.map((photo) => {
						const isActive = activePhotoId === photo.id;
						const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";
						const isRejected = photo.flag === "reject";
						const badge = badgeLabel?.(photo);

						return (
							<div
								key={photo.id}
								data-photo-id={photo.id}
								data-rejected={isRejected || undefined}
								className={cn(
									"group relative aspect-square cursor-pointer overflow-hidden bg-muted",
									"transition-all duration-75",
									"ring-inset",
									isActive && "ring-2 ring-selection brightness-110",
									!isActive && "hover:ring-1 hover:ring-thumbnail-border",
									isRejected && "opacity-40",
								)}
								onClick={() => handleClick(photo)}
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
										src={getThumbnailUrl(photo.id, "small", photo.thumbnailUpdatedAt)}
										srcSet={getThumbnailSrcSet(photo.id, photo.thumbnailUpdatedAt)}
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

								{badge && (
									<div
										data-testid="photo-badge"
										className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
									>
										{badge}
									</div>
								)}

								{/* Rating / flag badge */}
								{(photo.rating > 0 || photo.flag) && (
									<div
										data-testid="curation-badge"
										className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
									>
										{photo.rating > 0 && (
											<span
												role="img"
												className="flex items-center gap-0.5"
												aria-label={`${photo.rating} ${photo.rating === 1 ? "star" : "stars"}`}
											>
												<Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
												{photo.rating}
											</span>
										)}
										{photo.flag === "pick" && (
											<Flag
												aria-label="Pick"
												className="h-3 w-3 fill-green-400 text-green-400"
											/>
										)}
										{photo.flag === "reject" && (
											<X
												aria-label="Rejected"
												className="h-3 w-3 stroke-[3] text-red-500"
											/>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</ScrollArea>
	);
}

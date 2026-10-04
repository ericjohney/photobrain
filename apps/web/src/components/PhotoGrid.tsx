import { AlertCircle, Camera, Flag, ImageIcon, Star, X } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { TimelineYearRail } from "@/components/TimelineYearRail";
import { ScrollArea } from "@/components/ui/scroll-area";
import { rawBadge } from "@/lib/raw-badge";
import { getThumbnailSrcSet, getThumbnailUrl } from "@/lib/thumbnails";
import type { TimelineSection } from "@/lib/timeline";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PhotoGridProps<T extends PhotoMetadata> {
	photos: T[];
	/**
	 * Timeline sections covering `photos` in order, each under a sticky
	 * header; null or omitted renders one ungrouped grid.
	 */
	sections?: TimelineSection<T>[] | null;
	activePhotoId?: number | null;
	thumbnailSize?: number;
	onPhotoClick?: (photo: T) => void;
	onPhotoDoubleClick?: (photo: T) => void;
	/** Optional per-photo label shown as a badge (e.g. a review reason). */
	badgeLabel?: (photo: T) => string | undefined;
	className?: string;
}

/** Distinct section years in display order, without "Unknown date". */
function sectionYears<T>(sections: TimelineSection<T>[]) {
	const years: number[] = [];
	for (const section of sections) {
		if (section.year !== null && years[years.length - 1] !== section.year) {
			years.push(section.year);
		}
	}
	return years;
}

export function PhotoGrid<T extends PhotoMetadata>({
	photos,
	sections = null,
	activePhotoId = null,
	thumbnailSize = 200,
	onPhotoClick,
	onPhotoDoubleClick,
	badgeLabel,
	className,
}: PhotoGridProps<T>) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const years = useMemo(
		() => (sections ? sectionYears(sections) : []),
		[sections],
	);

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

	const renderTiles = (tiles: T[]) =>
		tiles.map((photo) => {
			const isActive = activePhotoId === photo.id;
			const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";
			const isRejected = photo.flag === "reject";
			const badge = badgeLabel?.(photo);
			const formatBadge = rawBadge(photo);

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
								{photo.rawStatus === "no_converter" ? "No Converter" : "Failed"}
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

					{/* RAW / RAW+JPEG pair badge */}
					{formatBadge && (
						<div
							data-testid="raw-badge"
							className="absolute left-1 top-1 rounded bg-orange-500/90 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
						>
							{formatBadge.label}
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
		});

	return (
		<div className={cn("flex h-full", className)}>
			<ScrollArea className="h-full min-w-0 flex-1" viewportRef={viewportRef}>
				<div className="p-1">
					{sections ? (
						<div data-testid="photo-grid">
							{sections.map((section) => (
								<section
									key={section.id}
									data-section-id={section.id}
									data-section-year={section.year ?? undefined}
									aria-label={section.title}
								>
									{/* The count is a bare number so it never reads like the toolbar's "N photos". */}
									<h2
										data-testid="timeline-section-header"
										className="sticky top-0 z-10 flex items-baseline gap-2 bg-background/95 px-1 py-1.5 backdrop-blur"
									>
										<span className="text-sm font-semibold">
											{section.title}
										</span>
										<span
											data-testid="timeline-section-count"
											title={`${section.photos.length} ${section.photos.length === 1 ? "photo" : "photos"}`}
											className="text-2xs text-muted-foreground tabular-nums"
										>
											{section.photos.length}
										</span>
									</h2>
									<div className="grid" style={gridStyle}>
										{renderTiles(section.photos)}
									</div>
								</section>
							))}
						</div>
					) : (
						<div data-testid="photo-grid" className="grid" style={gridStyle}>
							{renderTiles(photos)}
						</div>
					)}
				</div>
			</ScrollArea>
			{years.length > 1 && (
				<TimelineYearRail years={years} viewportRef={viewportRef} />
			)}
		</div>
	);
}

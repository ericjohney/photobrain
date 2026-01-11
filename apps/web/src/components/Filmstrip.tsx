import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { Camera } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { getThumbnailUrl } from "@/lib/thumbnails";
import { cn } from "@/lib/utils";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface FilmstripProps {
	photos: PhotoMetadata[];
	activePhotoId?: number | null;
	selectedPhotos?: Set<number>;
	onPhotoClick?: (photo: PhotoMetadata) => void;
	className?: string;
}

export function Filmstrip({
	photos,
	activePhotoId,
	selectedPhotos = new Set(),
	onPhotoClick,
	className,
}: FilmstripProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLButtonElement>(null);

	// Scroll active photo into view
	useEffect(() => {
		if (activeRef.current) {
			activeRef.current.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
				inline: "center",
			});
		}
	}, [activePhotoId]);

	const handleClick = useCallback(
		(photo: PhotoMetadata) => {
			onPhotoClick?.(photo);
		},
		[onPhotoClick],
	);

	if (photos.length === 0) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center text-muted-foreground",
					className,
				)}
			>
				<p className="text-xs">No photos</p>
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className={cn(
				"flex h-full w-full items-center gap-0.5 overflow-x-auto px-2 py-2",
				className,
			)}
		>
			{photos.map((photo) => {
				const isActive = activePhotoId === photo.id;
				const isSelected = selectedPhotos.has(photo.id);
				const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";

				return (
					<button
						key={photo.id}
						ref={isActive ? activeRef : undefined}
						type="button"
						onClick={() => handleClick(photo)}
						className={cn(
							"relative flex-shrink-0 overflow-hidden",
							"h-full aspect-[3/2]",
							"transition-all duration-75",
							"ring-inset focus:outline-none",
							isActive && "ring-2 ring-selection brightness-110",
							isSelected && !isActive && "ring-1 ring-selection/70",
							!isActive &&
								!isSelected &&
								"opacity-70 hover:opacity-100 hover:ring-1 hover:ring-thumbnail-border",
						)}
					>
						{isFailedRaw ? (
							<div className="flex h-full w-full items-center justify-center bg-muted">
								<Camera className="h-4 w-4 opacity-50 text-muted-foreground" />
							</div>
						) : (
							<img
								src={getThumbnailUrl(photo.id, "tiny")}
								alt={photo.name}
								className="h-full w-full object-cover"
								loading="lazy"
								draggable={false}
							/>
						)}

						{/* RAW indicator */}
						{photo.isRaw && (
							<div className="absolute left-0.5 top-0.5 rounded bg-orange-500/90 px-0.5 text-[8px] font-semibold text-white">
								R
							</div>
						)}
					</button>
				);
			})}
		</div>
	);
}

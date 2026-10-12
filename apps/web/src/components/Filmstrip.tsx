import { Camera } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DurationBadge, RawBadge } from "@/components/ui/badge";
import { VIRTUALIZE_MIN_PHOTOS } from "@/components/PhotoGrid";
import { rawBadge } from "@/lib/raw-badge";
import { getThumbnailUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FilmstripProps {
	photos: PhotoMetadata[];
	activePhotoId?: number | null;
	onPhotoClick?: (photo: PhotoMetadata) => void;
	className?: string;
}

/** Horizontal padding and gap between thumbnails, in px. */
const PADDING_X = 12;
const GAP = 4;
/** Vertical padding (`py-2`), in px: thumbnails fill the remaining height. */
const PADDING_Y = 8;

interface FilmstripTileProps {
	photo: PhotoMetadata;
	active: boolean;
	left: number;
	width: number;
	onClick?: (photo: PhotoMetadata) => void;
}

const FilmstripTile = memo(function FilmstripTile({
	photo,
	active,
	left,
	width,
	onClick,
}: FilmstripTileProps) {
	const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";
	const isRejected = photo.flag === "reject";
	const formatBadge = rawBadge(photo);
	return (
		<button
			type="button"
			data-filmstrip-photo-id={photo.id}
			data-rejected={isRejected || undefined}
			onClick={() => onClick?.(photo)}
			style={{ left, width, top: PADDING_Y, bottom: PADDING_Y }}
			className={cn(
				"group absolute overflow-hidden rounded",
				"transition-[box-shadow,opacity] duration-100",
				"ring-inset focus:outline-none",
				active && "ring-2 ring-selection",
				!active && "opacity-60 hover:opacity-100",
				isRejected && "opacity-30 hover:opacity-50",
			)}
		>
			{isFailedRaw ? (
				<div className="flex h-full w-full items-center justify-center bg-secondary">
					<Camera className="h-4 w-4 text-subtle" />
				</div>
			) : (
				<img
					src={getThumbnailUrl(photo.id, "tiny", photo.thumbnailUpdatedAt)}
					alt={photo.name}
					className="h-full w-full object-cover"
					decoding="async"
					draggable={false}
				/>
			)}

			{/* Selection frame, drawn above the image. */}
			<span
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-0 rounded ring-inset",
					active
						? "ring-2 ring-selection"
						: "group-hover:ring-1 group-hover:ring-foreground/20",
				)}
			/>

			{/* RAW / RAW+JPEG pair indicator */}
			{formatBadge && (
				<RawBadge
					data-testid="filmstrip-raw-badge"
					badge={formatBadge}
					size="xs"
					className="absolute left-0.5 top-0.5 shadow-none"
				/>
			)}

			{photo.mediaType === "video" && (
				<DurationBadge
					data-testid="filmstrip-duration-badge"
					durationMs={photo.durationMs}
					size="xs"
					className="absolute bottom-0.5 right-0.5 gap-px"
				/>
			)}
		</button>
	);
});

/**
 * Loupe filmstrip of 3:2 thumbnails, virtualized horizontally: only tiles
 * within about a strip width of the visible range are rendered.
 */
export function Filmstrip({
	photos,
	activePhotoId,
	onPhotoClick,
	className,
}: FilmstripProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [scrollLeft, setScrollLeft] = useState(0);
	const empty = photos.length === 0;

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || empty) return;
		const measure = () =>
			setSize((current) =>
				current.width === el.clientWidth && current.height === el.clientHeight
					? current
					: { width: el.clientWidth, height: el.clientHeight },
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [empty]);

	const tileWidth = Math.max(1, ((size.height - PADDING_Y * 2) * 3) / 2);
	const stride = tileWidth + GAP;
	const step = Math.max(100, Math.floor(size.width / 2));

	useEffect(() => {
		const el = scrollRef.current;
		if (!el || empty) return;
		const update = () => setScrollLeft(Math.floor(el.scrollLeft / step) * step);
		update();
		el.addEventListener("scroll", update, { passive: true });
		return () => el.removeEventListener("scroll", update);
	}, [step, empty]);

	// Center the active photo (like scrollIntoView inline: center).
	const activeIndex =
		activePhotoId == null
			? -1
			: photos.findIndex((photo) => photo.id === activePhotoId);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || activeIndex === -1 || size.width === 0) return;
		const center = PADDING_X + activeIndex * stride + tileWidth / 2;
		const target = Math.max(0, center - el.clientWidth / 2);
		// Smooth only for short hops; long jumps would animate through
		// thousands of thumbnails.
		const near = Math.abs(target - el.scrollLeft) < el.clientWidth * 2;
		el.scrollTo({ left: target, behavior: near ? "smooth" : "auto" });
	}, [activeIndex, stride, tileWidth, size.width]);

	if (empty) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center text-subtle",
					className,
				)}
			>
				<p className="text-xs">No photos</p>
			</div>
		);
	}

	// Like the grid, short lists render every tile.
	const virtualized = photos.length >= VIRTUALIZE_MIN_PHOTOS;
	const overscan = Math.max(size.width, 400);
	const first = virtualized
		? Math.max(0, Math.floor((scrollLeft - overscan - PADDING_X) / stride))
		: 0;
	const last = !virtualized
		? photos.length - 1
		: size.width === 0
			? -1
			: Math.min(
					photos.length - 1,
					Math.ceil((scrollLeft + step + size.width + overscan) / stride),
				);
	const contentWidth = PADDING_X * 2 + photos.length * stride - GAP;

	return (
		<div
			ref={scrollRef}
			className={cn("relative h-full w-full overflow-x-auto", className)}
		>
			<div className="relative h-full" style={{ width: contentWidth }}>
				{photos.slice(first, last + 1).map((photo, offset) => (
					<FilmstripTile
						key={photo.id}
						photo={photo}
						active={photo.id === activePhotoId}
						left={PADDING_X + (first + offset) * stride}
						width={tileWidth}
						onClick={onPhotoClick}
					/>
				))}
			</div>
		</div>
	);
}

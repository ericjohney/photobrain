import { AlertCircle, Camera, Flag, ImageIcon, Star, X } from "lucide-react";
import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { DurationBadge, LiveBadge } from "@/components/MediaBadges";
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

/** Gap between tiles, in px (matches the grid's CSS `gap`). */
const GAP = 2;
/** Padding around the grid content (`p-1`), in px. */
const PADDING = 4;
/** Height of a sticky timeline section header (`h-8`), in px. */
const HEADER_HEIGHT = 32;
/**
 * Lists up to this many photos render every tile: they are cheap, and
 * keeping them all in the DOM keeps small views simple. Larger lists render
 * only the rows near the viewport.
 */
export const VIRTUALIZE_MIN_PHOTOS = 300;

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

/**
 * Column count and tile size for a content width, matching CSS
 * `repeat(auto-fill, minmax(size, 1fr))` with a `GAP` gap.
 */
export function gridMetrics(contentWidth: number, thumbnailSize: number) {
	const columns = Math.max(
		1,
		Math.floor((contentWidth + GAP) / (thumbnailSize + GAP)),
	);
	const tile = Math.max(0, (contentWidth - GAP * (columns - 1)) / columns);
	return { columns, tile, stride: tile + GAP };
}

interface LaidOutSection<T> {
	id: string;
	title: string | null;
	year: number | null;
	photos: T[];
	/** Offset of the section's first tile row within the scroll content. */
	gridTop: number;
	gridHeight: number;
}

interface PhotoTileProps<T extends PhotoMetadata> {
	photo: T;
	active: boolean;
	thumbnailSize: number;
	badge: string | undefined;
	onClick?: (photo: T) => void;
	onDoubleClick?: (photo: T) => void;
}

/**
 * One grid tile. Memoized so selecting a photo re-renders only the
 * previously and newly active tiles.
 */
const PhotoTile = memo(function PhotoTile<T extends PhotoMetadata>({
	photo,
	active,
	thumbnailSize,
	badge,
	onClick,
	onDoubleClick,
}: PhotoTileProps<T>) {
	const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";
	const isRejected = photo.flag === "reject";
	const formatBadge = rawBadge(photo);

	return (
		<div
			data-photo-id={photo.id}
			data-rejected={isRejected || undefined}
			className={cn(
				"group relative aspect-square cursor-pointer overflow-hidden bg-muted",
				"transition-all duration-75",
				"ring-inset",
				active && "ring-2 ring-selection brightness-110",
				!active && "hover:ring-1 hover:ring-thumbnail-border",
				isRejected && "opacity-40",
			)}
			onClick={() => onClick?.(photo)}
			onDoubleClick={() => onDoubleClick?.(photo)}
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
					decoding="async"
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

			{/* Live Photo: a still with a motion clip */}
			{photo.motionVideoId !== null && (
				<LiveBadge className="absolute right-1 top-1" />
			)}

			{/* Filename on hover */}
			<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100">
				<p className="truncate text-2xs font-medium text-white">{photo.name}</p>
			</div>

			{badge && (
				<div
					data-testid="photo-badge"
					className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
				>
					{badge}
				</div>
			)}

			<div className="absolute bottom-1 right-1 flex items-center gap-1">
				{/* Rating / flag badge */}
				{(photo.rating > 0 || photo.flag) && (
					<div
						data-testid="curation-badge"
						className="flex items-center gap-1 rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
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
				{photo.mediaType === "video" && (
					<DurationBadge durationMs={photo.durationMs} />
				)}
			</div>
		</div>
	);
}) as <T extends PhotoMetadata>(props: PhotoTileProps<T>) => JSX.Element;

/**
 * Photo grid, virtualized by row: every timeline section keeps its full
 * computed height (so sticky headers and the year rail work), but only tile
 * rows within about a viewport of the visible area are rendered.
 */
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

	// Viewport size and the rendered pixel window. The window moves in
	// half-viewport steps, so scrolling re-renders only a few times a screen.
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [windowTop, setWindowTop] = useState(0);

	const empty = photos.length === 0;
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || empty) return;
		const measure = () =>
			setSize((current) =>
				current.width === viewport.clientWidth &&
				current.height === viewport.clientHeight
					? current
					: { width: viewport.clientWidth, height: viewport.clientHeight },
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [empty]);

	const step = Math.max(200, Math.floor(size.height / 2));
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || empty) return;
		const update = () =>
			setWindowTop(Math.floor(viewport.scrollTop / step) * step);
		update();
		viewport.addEventListener("scroll", update, { passive: true });
		return () => viewport.removeEventListener("scroll", update);
	}, [step, empty]);

	const { columns, stride } = gridMetrics(
		size.width - PADDING * 2,
		thumbnailSize,
	);

	const layout = useMemo(() => {
		const groups: Omit<LaidOutSection<T>, "gridTop" | "gridHeight">[] = sections
			? sections.map((s) => ({
					id: s.id,
					title: s.title,
					year: s.year,
					photos: s.photos,
				}))
			: [{ id: "all", title: null, year: null, photos }];
		let offset = PADDING;
		return groups.map((group) => {
			const rows = Math.ceil(group.photos.length / columns);
			const gridTop = offset + (group.title === null ? 0 : HEADER_HEIGHT);
			const gridHeight = rows > 0 ? rows * stride - GAP : 0;
			offset = gridTop + gridHeight;
			return { ...group, gridTop, gridHeight };
		});
	}, [sections, photos, columns, stride]);

	// Rendered pixel range: one viewport of overscan above and below.
	const virtualized = photos.length >= VIRTUALIZE_MIN_PHOTOS;
	const overscan = Math.max(size.height, 400);
	const renderTop = virtualized
		? windowTop - overscan
		: Number.NEGATIVE_INFINITY;
	const renderBottom = virtualized
		? windowTop + step + size.height + overscan
		: Number.POSITIVE_INFINITY;

	// Keep the active photo in view (e.g. arrow keys, or returning from the
	// loupe), since its tile may not be rendered at all.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || activePhotoId === null || stride <= 0) return;
		for (const section of layout) {
			const index = section.photos.findIndex((p) => p.id === activePhotoId);
			if (index === -1) continue;
			const top = section.gridTop + Math.floor(index / columns) * stride;
			// Sticky headers cover the top of the viewport.
			const visibleTop =
				viewport.scrollTop + (section.title === null ? 0 : HEADER_HEIGHT);
			const visibleBottom = viewport.scrollTop + viewport.clientHeight;
			if (top < visibleTop) {
				viewport.scrollTop = top - (visibleTop - viewport.scrollTop);
			} else if (top + stride - GAP > visibleBottom) {
				viewport.scrollTop = top + stride - GAP - viewport.clientHeight;
			}
			return;
		}
	}, [activePhotoId, layout, columns, stride]);

	if (empty) {
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

	/** The visible tile rows of one section, positioned within its grid box. */
	const renderRows = (section: LaidOutSection<T>) => {
		if (size.width === 0 || stride <= 0) return null;
		const sectionBottom = section.gridTop + section.gridHeight;
		if (sectionBottom < renderTop || section.gridTop > renderBottom) {
			return null;
		}
		const rows = Math.ceil(section.photos.length / columns);
		const firstRow = Math.max(
			0,
			Math.floor((renderTop - section.gridTop) / stride),
		);
		const lastRow = Math.min(
			rows - 1,
			Math.floor((renderBottom - section.gridTop) / stride),
		);
		if (lastRow < firstRow) return null;
		const tiles = section.photos.slice(
			firstRow * columns,
			(lastRow + 1) * columns,
		);
		return (
			<div
				className="absolute inset-x-0 grid"
				style={{
					top: firstRow * stride,
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
					gap: `${GAP}px`,
				}}
			>
				{tiles.map((photo) => (
					<PhotoTile
						key={photo.id}
						photo={photo}
						active={activePhotoId === photo.id}
						thumbnailSize={thumbnailSize}
						badge={badgeLabel?.(photo)}
						onClick={onPhotoClick}
						onDoubleClick={onPhotoDoubleClick}
					/>
				))}
			</div>
		);
	};

	return (
		<div className={cn("flex h-full", className)}>
			<ScrollArea className="h-full min-w-0 flex-1" viewportRef={viewportRef}>
				<div style={{ padding: PADDING }}>
					{sections ? (
						<div data-testid="photo-grid">
							{layout.map((section) => (
								<section
									key={section.id}
									data-section-id={section.id}
									data-section-year={section.year ?? undefined}
									aria-label={section.title ?? undefined}
								>
									{/* The count is a bare number so it never reads like the toolbar's "N photos". */}
									<h2
										data-testid="timeline-section-header"
										className="sticky top-0 z-10 flex h-8 items-baseline gap-2 bg-background/95 px-1 py-1.5 backdrop-blur"
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
									<div
										className="relative"
										style={{ height: section.gridHeight }}
									>
										{renderRows(section)}
									</div>
								</section>
							))}
						</div>
					) : (
						<div
							data-testid="photo-grid"
							className="relative"
							style={{ height: layout[0].gridHeight }}
						>
							{renderRows(layout[0])}
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

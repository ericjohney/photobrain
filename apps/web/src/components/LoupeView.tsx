import {
	Camera,
	ChevronLeft,
	ChevronRight,
	Maximize,
	Minimize,
} from "lucide-react";
import {
	type MutableRefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { rawBadge } from "@/lib/raw-badge";
import { getFullImageUrl, getThumbnailUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

type ZoomLevel = "fit" | "fill" | "100";

interface LoupeViewProps {
	photo: PhotoMetadata | null;
	onNavigate?: (direction: "prev" | "next") => void;
	hasPrev?: boolean;
	hasNext?: boolean;
	/** Receives the shown video's element (null otherwise), for `Space` play/pause. */
	videoRef?: MutableRefObject<HTMLVideoElement | null>;
	className?: string;
}

/**
 * Ref callback for a loupe `<video>`: publishes the element to `targetRef`
 * and, when it unmounts (another photo, grid, or leaving the loupe), pauses
 * it and drops its source so the browser releases the media resource.
 */
function useReleasingVideoRef(
	targetRef?: MutableRefObject<HTMLVideoElement | null>,
) {
	const elementRef = useRef<HTMLVideoElement | null>(null);
	return useCallback(
		(element: HTMLVideoElement | null) => {
			const previous = elementRef.current;
			if (previous && previous !== element) {
				previous.pause();
				previous.removeAttribute("src");
				previous.load();
			}
			elementRef.current = element;
			if (targetRef) targetRef.current = element;
		},
		[targetRef],
	);
}

/** The loupe's video player: native controls, paused until the user plays it. */
function LoupeVideo({
	photo,
	videoRef,
}: {
	photo: PhotoMetadata;
	videoRef?: MutableRefObject<HTMLVideoElement | null>;
}) {
	const ref = useReleasingVideoRef(videoRef);
	return (
		// biome-ignore lint/a11y/useMediaCaption: personal library videos carry no caption tracks.
		<video
			ref={ref}
			data-testid="loupe-video"
			src={getFullImageUrl(photo.id, photo.thumbnailUpdatedAt)}
			poster={getThumbnailUrl(photo.id, "large", photo.thumbnailUpdatedAt)}
			aria-label={photo.name}
			controls
			playsInline
			preload="metadata"
			className="max-h-full max-w-full object-contain"
		/>
	);
}

/** A Live Photo's motion clip, played once (muted, inline) over the still. */
function LiveMotionVideo({
	motionVideoId,
	onDone,
}: {
	motionVideoId: number;
	onDone: () => void;
}) {
	const releasingRef = useReleasingVideoRef();
	const ref = useCallback(
		(element: HTMLVideoElement | null) => {
			releasingRef(element);
			// A rejected play (e.g. unsupported codec) returns to the still.
			element?.play().catch(onDone);
		},
		[releasingRef, onDone],
	);
	return (
		<video
			ref={ref}
			data-testid="live-video"
			src={getFullImageUrl(motionVideoId)}
			muted
			playsInline
			preload="auto"
			onEnded={onDone}
			onError={onDone}
			className="absolute inset-0 h-full w-full object-contain"
		/>
	);
}

export function LoupeView({
	photo,
	onNavigate,
	hasPrev = false,
	hasNext = false,
	videoRef,
	className,
}: LoupeViewProps) {
	const [zoomLevel, setZoomLevel] = useState<ZoomLevel>("fit");
	const [imageLoaded, setImageLoaded] = useState(false);
	const [livePlaying, setLivePlaying] = useState(false);
	const stopLive = useCallback(() => setLivePlaying(false), []);

	// Reset image loaded and Live playback state when photo changes
	useEffect(() => {
		setImageLoaded(false);
		setLivePlaying(false);
	}, [photo?.id]);

	const handleZoomChange = useCallback(() => {
		setZoomLevel((current) => {
			if (current === "fit") return "fill";
			if (current === "fill") return "100";
			return "fit";
		});
	}, []);

	const handlePrev = useCallback(() => {
		onNavigate?.("prev");
	}, [onNavigate]);

	const handleNext = useCallback(() => {
		onNavigate?.("next");
	}, [onNavigate]);

	if (!photo) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center text-muted-foreground",
					className,
				)}
			>
				<p className="text-sm">No photo selected</p>
			</div>
		);
	}

	const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";
	const isVideo = photo.mediaType === "video";
	const formatBadge = rawBadge(photo);

	const getImageSrc = () => {
		if (zoomLevel === "100") {
			return getFullImageUrl(photo.id, photo.thumbnailUpdatedAt);
		}
		return getThumbnailUrl(photo.id, "large", photo.thumbnailUpdatedAt);
	};

	const getImageClass = () => {
		switch (zoomLevel) {
			case "fit":
				return "max-h-full max-w-full object-contain";
			case "fill":
				return "min-h-full min-w-full object-cover";
			case "100":
				return ""; // Natural size
			default:
				return "max-h-full max-w-full object-contain";
		}
	};

	return (
		<div
			data-testid="loupe-view"
			className={cn(
				"relative flex h-full w-full items-center justify-center overflow-hidden bg-background",
				className,
			)}
		>
			{/* Main image */}
			{isVideo ? (
				<LoupeVideo key={photo.id} photo={photo} videoRef={videoRef} />
			) : isFailedRaw ? (
				<div className="flex flex-col items-center justify-center text-muted-foreground">
					<Camera className="h-24 w-24 mb-4 opacity-30" />
					<p className="text-lg mb-2">RAW Conversion Failed</p>
					<p className="text-sm text-muted-foreground mb-4">
						{photo.rawError || "Unknown error"}
					</p>
					<p className="text-xs text-muted-foreground">
						Re-run scan to retry conversion
					</p>
				</div>
			) : (
				<div
					className={cn(
						"flex h-full w-full items-center justify-center",
						zoomLevel === "100" && "overflow-auto",
					)}
				>
					{/* Loading placeholder */}
					{!imageLoaded && (
						<img
							src={getThumbnailUrl(
								photo.id,
								"medium",
								photo.thumbnailUpdatedAt,
							)}
							alt=""
							className="absolute max-h-full max-w-full object-contain blur-sm"
						/>
					)}
					<img
						src={getImageSrc()}
						alt={photo.name}
						className={cn(
							getImageClass(),
							!imageLoaded && "opacity-0",
							"transition-opacity duration-200",
						)}
						onLoad={() => setImageLoaded(true)}
						draggable={false}
					/>
					{livePlaying && photo.motionVideoId !== null && (
						<LiveMotionVideo
							key={photo.motionVideoId}
							motionVideoId={photo.motionVideoId}
							onDone={stopLive}
						/>
					)}
				</div>
			)}

			{/* RAW / RAW+JPEG pair badge */}
			{formatBadge && (
				<div
					data-testid="loupe-raw-badge"
					className="absolute left-3 top-3 rounded bg-orange-500/90 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm"
				>
					{formatBadge.label}
				</div>
			)}

			{/* Live Photo: play the motion clip over the still */}
			{!isVideo && !isFailedRaw && photo.motionVideoId !== null && (
				<button
					type="button"
					aria-pressed={livePlaying}
					aria-label="Play Live Photo"
					onClick={() => setLivePlaying(true)}
					className={cn(
						"absolute right-3 top-3 rounded bg-black/50 px-1.5 py-0.5 text-2xs font-semibold tracking-wide text-white shadow-sm hover:bg-black/70",
						livePlaying && "bg-primary/80 hover:bg-primary/80",
					)}
				>
					LIVE
				</button>
			)}

			{/* Navigation arrows */}
			{hasPrev && (
				<button
					type="button"
					onClick={handlePrev}
					className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white opacity-0 transition-opacity hover:bg-black/60 group-hover:opacity-100 focus:opacity-100"
				>
					<ChevronLeft className="h-6 w-6" />
				</button>
			)}
			{hasNext && (
				<button
					type="button"
					onClick={handleNext}
					className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white opacity-0 transition-opacity hover:bg-black/60 group-hover:opacity-100 focus:opacity-100"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			)}

			{/* Zoom controls */}
			<TooltipProvider>
				<div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-black/40 px-2 py-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-white hover:bg-white/20"
								onClick={() => setZoomLevel("fit")}
							>
								<Minimize
									className={cn(
										"h-4 w-4",
										zoomLevel === "fit" && "text-primary",
									)}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>Fit to view</TooltipContent>
					</Tooltip>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-white hover:bg-white/20"
								onClick={() => setZoomLevel("fill")}
							>
								<Maximize
									className={cn(
										"h-4 w-4",
										zoomLevel === "fill" && "text-primary",
									)}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>Fill view</TooltipContent>
					</Tooltip>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-white hover:bg-white/20"
								onClick={() => setZoomLevel("100")}
							>
								<span
									className={cn(
										"text-xs font-medium",
										zoomLevel === "100" && "text-primary",
									)}
								>
									1:1
								</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent>Actual size (100%)</TooltipContent>
					</Tooltip>
				</div>
			</TooltipProvider>

			{/* Photo info overlay */}
			<div className="absolute bottom-4 right-4 rounded bg-black/40 px-2 py-1 text-xs text-white">
				{photo.name}
			</div>
		</div>
	);
}

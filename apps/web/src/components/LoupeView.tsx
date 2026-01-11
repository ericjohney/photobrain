import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import {
	Camera,
	ChevronLeft,
	ChevronRight,
	Maximize,
	Minimize,
	RefreshCw,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFullImageUrl, getThumbnailUrl } from "@/lib/thumbnails";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

type ZoomLevel = "fit" | "fill" | "100";

interface LoupeViewProps {
	photo: PhotoMetadata | null;
	onNavigate?: (direction: "prev" | "next") => void;
	hasPrev?: boolean;
	hasNext?: boolean;
	className?: string;
}

export function LoupeView({
	photo,
	onNavigate,
	hasPrev = false,
	hasNext = false,
	className,
}: LoupeViewProps) {
	const [zoomLevel, setZoomLevel] = useState<ZoomLevel>("fit");
	const [imageLoaded, setImageLoaded] = useState(false);

	const utils = trpc.useUtils();
	const reprocessMutation = trpc.reprocessRaw.useMutation({
		onSuccess: () => {
			utils.photos.invalidate();
		},
	});

	// Reset image loaded state when photo changes
	useEffect(() => {
		setImageLoaded(false);
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

	const getImageSrc = () => {
		if (zoomLevel === "100") {
			return getFullImageUrl(photo.id);
		}
		return getThumbnailUrl(photo.id, "large");
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
			className={cn(
				"relative flex h-full w-full items-center justify-center overflow-hidden bg-background",
				className,
			)}
		>
			{/* Main image */}
			{isFailedRaw ? (
				<div className="flex flex-col items-center justify-center text-muted-foreground">
					<Camera className="h-24 w-24 mb-4 opacity-30" />
					<p className="text-lg mb-2">RAW Conversion Failed</p>
					<p className="text-sm text-muted-foreground mb-4">
						{photo.rawError || "Unknown error"}
					</p>
					<Button
						onClick={() => reprocessMutation.mutate({ id: photo.id })}
						disabled={reprocessMutation.isPending}
						className="gap-2"
					>
						<RefreshCw
							className={cn(
								"h-4 w-4",
								reprocessMutation.isPending && "animate-spin",
							)}
						/>
						{reprocessMutation.isPending ? "Retrying..." : "Retry Conversion"}
					</Button>
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
							src={getThumbnailUrl(photo.id, "medium")}
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
				</div>
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

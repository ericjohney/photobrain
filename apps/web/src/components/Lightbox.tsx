import type { AppRouter } from "@photobrain/api";
import { formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import {
	AlertTriangle,
	Aperture,
	Camera,
	Clock,
	FileImage,
	MapPin,
	RefreshCw,
	X,
} from "lucide-react";
import { useEffect } from "react";
import { getFullImageUrl, getThumbnailUrl } from "@/lib/thumbnails";
import { trpc } from "@/lib/trpc";

// Infer types from tRPC router
type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface LightboxProps {
	photo: PhotoMetadata;
	onClose: () => void;
}

export function Lightbox({ photo, onClose }: LightboxProps) {
	const utils = trpc.useUtils();
	const reprocessMutation = trpc.reprocessRaw.useMutation({
		onSuccess: () => {
			// Invalidate and refetch photos
			utils.photos.invalidate();
		},
	});

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const hasExif = photo.exif !== null && photo.exif !== undefined;
	const isFailedRaw = photo.isRaw && photo.rawStatus !== "converted";

	return (
		<div
			className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
			onClick={onClose}
		>
			<div
				className="relative w-full h-full flex"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Image container */}
				<div className="flex-1 flex items-center justify-center p-4">
					{isFailedRaw ? (
						<div className="flex flex-col items-center justify-center text-gray-400">
							<Camera className="w-24 h-24 mb-4 opacity-50" />
							<p className="text-lg mb-2">RAW Conversion Failed</p>
							<p className="text-sm text-gray-500 mb-4">
								{photo.rawError || "Unknown error"}
							</p>
							<button
								onClick={() => reprocessMutation.mutate({ id: photo.id })}
								disabled={reprocessMutation.isPending}
								className="flex items-center gap-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg transition-colors"
							>
								<RefreshCw
									className={`w-4 h-4 ${reprocessMutation.isPending ? "animate-spin" : ""}`}
								/>
								{reprocessMutation.isPending
									? "Retrying..."
									: "Retry Conversion"}
							</button>
							{reprocessMutation.isError && (
								<p className="text-red-400 text-sm mt-2">
									{reprocessMutation.error.message}
								</p>
							)}
						</div>
					) : (
						<img
							src={getThumbnailUrl(photo.id, "large")}
							srcSet={`
								${getThumbnailUrl(photo.id, "medium")} 800w,
								${getThumbnailUrl(photo.id, "large")} 1600w,
								${getFullImageUrl(photo.id)} 4000w
							`}
							sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 70vw"
							alt={photo.name}
							className="max-w-full max-h-full object-contain rounded-lg"
						/>
					)}
				</div>

				{/* Info sidebar */}
				<div className="w-80 bg-black/70 backdrop-blur-sm text-white p-6 overflow-y-auto">
					{/* Close button */}
					<button
						onClick={onClose}
						className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2 transition-colors"
						aria-label="Close"
					>
						<X className="w-6 h-6" />
					</button>

					{/* Photo info */}
					<div className="space-y-6">
						<div>
							<h2 className="text-lg font-semibold mb-2 pr-8">{photo.name}</h2>
							<div className="text-sm text-gray-300 space-y-1">
								<p>{formatFileSize(photo.size)}</p>
								{photo.width && photo.height && (
									<p>
										{photo.width} × {photo.height}
									</p>
								)}
								<p>{new Date(photo.modifiedAt).toLocaleDateString()}</p>
							</div>
						</div>

						{/* RAW file info */}
						{photo.isRaw && (
							<div>
								<div className="flex items-center gap-2 mb-2">
									<FileImage className="w-4 h-4 text-orange-400" />
									<h3 className="text-sm font-semibold text-gray-300">
										RAW File
									</h3>
								</div>
								<div className="text-sm space-y-1">
									<p className="text-orange-400 font-medium">
										{photo.rawFormat || "RAW"}
									</p>
									<p className="text-gray-400">
										Status:{" "}
										<span
											className={
												photo.rawStatus === "converted"
													? "text-green-400"
													: photo.rawStatus === "failed"
														? "text-red-400"
														: "text-yellow-400"
											}
										>
											{photo.rawStatus === "converted"
												? "Converted"
												: photo.rawStatus === "failed"
													? "Failed"
													: photo.rawStatus === "no_converter"
														? "No Converter"
														: "Unknown"}
										</span>
									</p>
									{photo.rawError && (
										<div className="mt-2 p-2 bg-red-900/30 rounded text-red-300 text-xs">
											<div className="flex items-start gap-1">
												<AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
												<span>{photo.rawError}</span>
											</div>
										</div>
									)}
									{photo.rawStatus !== "converted" && (
										<button
											onClick={() => reprocessMutation.mutate({ id: photo.id })}
											disabled={reprocessMutation.isPending}
											className="mt-2 flex items-center gap-1 text-xs bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 text-white px-2 py-1 rounded transition-colors"
										>
											<RefreshCw
												className={`w-3 h-3 ${reprocessMutation.isPending ? "animate-spin" : ""}`}
											/>
											{reprocessMutation.isPending ? "Retrying..." : "Retry"}
										</button>
									)}
								</div>
							</div>
						)}

						{/* EXIF data */}
						{hasExif && (
							<>
								{/* Camera info */}
								{(photo.exif.cameraMake || photo.exif.cameraModel) && (
									<div>
										<div className="flex items-center gap-2 mb-2">
											<Camera className="w-4 h-4 text-gray-400" />
											<h3 className="text-sm font-semibold text-gray-300">
												Camera
											</h3>
										</div>
										<div className="text-sm space-y-1">
											{photo.exif.cameraMake && <p>{photo.exif.cameraMake}</p>}
											{photo.exif.cameraModel && (
												<p className="text-gray-400">
													{photo.exif.cameraModel}
												</p>
											)}
										</div>
									</div>
								)}

								{/* Lens info */}
								{(photo.exif.lensModel || photo.exif.lensMake) && (
									<div>
										<div className="flex items-center gap-2 mb-2">
											<Aperture className="w-4 h-4 text-gray-400" />
											<h3 className="text-sm font-semibold text-gray-300">
												Lens
											</h3>
										</div>
										<div className="text-sm space-y-1">
											{photo.exif.lensMake && <p>{photo.exif.lensMake}</p>}
											{photo.exif.lensModel && (
												<p className="text-gray-400">{photo.exif.lensModel}</p>
											)}
										</div>
									</div>
								)}

								{/* Exposure settings */}
								{(photo.exif.iso ||
									photo.exif.aperture ||
									photo.exif.shutterSpeed ||
									photo.exif.focalLength ||
									photo.exif.exposureBias) && (
									<div>
										<div className="flex items-center gap-2 mb-2">
											<Clock className="w-4 h-4 text-gray-400" />
											<h3 className="text-sm font-semibold text-gray-300">
												Settings
											</h3>
										</div>
										<div className="text-sm space-y-1">
											{photo.exif.focalLength && (
												<p>
													<span className="text-gray-400">Focal Length:</span>{" "}
													{photo.exif.focalLength}mm
												</p>
											)}
											{photo.exif.aperture && (
												<p>
													<span className="text-gray-400">Aperture:</span>{" "}
													{photo.exif.aperture}
												</p>
											)}
											{photo.exif.shutterSpeed && (
												<p>
													<span className="text-gray-400">Shutter:</span>{" "}
													{photo.exif.shutterSpeed}
												</p>
											)}
											{photo.exif.iso && (
												<p>
													<span className="text-gray-400">ISO:</span>{" "}
													{photo.exif.iso}
												</p>
											)}
											{photo.exif.exposureBias && (
												<p>
													<span className="text-gray-400">Exposure:</span>{" "}
													{photo.exif.exposureBias}
												</p>
											)}
										</div>
									</div>
								)}

								{/* Date taken */}
								{photo.exif.dateTaken && (
									<div>
										<div className="flex items-center gap-2 mb-2">
											<Clock className="w-4 h-4 text-gray-400" />
											<h3 className="text-sm font-semibold text-gray-300">
												Date Taken
											</h3>
										</div>
										<p className="text-sm">{photo.exif.dateTaken}</p>
									</div>
								)}

								{/* GPS location */}
								{(photo.exif.gpsLatitude || photo.exif.gpsLongitude) && (
									<div>
										<div className="flex items-center gap-2 mb-2">
											<MapPin className="w-4 h-4 text-gray-400" />
											<h3 className="text-sm font-semibold text-gray-300">
												Location
											</h3>
										</div>
										<div className="text-sm space-y-1">
											{photo.exif.gpsLatitude && (
												<p>
													<span className="text-gray-400">Latitude:</span>{" "}
													{photo.exif.gpsLatitude}
												</p>
											)}
											{photo.exif.gpsLongitude && (
												<p>
													<span className="text-gray-400">Longitude:</span>{" "}
													{photo.exif.gpsLongitude}
												</p>
											)}
											{photo.exif.gpsAltitude && (
												<p>
													<span className="text-gray-400">Altitude:</span>{" "}
													{photo.exif.gpsAltitude}m
												</p>
											)}
										</div>
									</div>
								)}
							</>
						)}

						{!hasExif && (
							<div className="text-sm text-gray-400">
								<p>No EXIF data available</p>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

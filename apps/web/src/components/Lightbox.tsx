import { X, Camera, Aperture, Clock, MapPin } from "lucide-react";
import { config } from "@/lib/config";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { formatFileSize } from "@photobrain/utils";

// Infer types from tRPC router
type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface LightboxProps {
	photo: PhotoMetadata;
	onClose: () => void;
}

export function Lightbox({ photo, onClose }: LightboxProps) {
	const getImageUrl = (photo: PhotoMetadata) => {
		return `${config.apiUrl}/api/photos/${photo.id}/file`;
	};

	const hasExif = photo.exif !== null && photo.exif !== undefined;

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
					<img
						src={getImageUrl(photo)}
						alt={photo.name}
						className="max-w-full max-h-full object-contain rounded-lg"
					/>
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
							<h2 className="text-lg font-semibold mb-2 pr-8">
								{photo.name}
							</h2>
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
											{photo.exif.cameraMake && (
												<p>{photo.exif.cameraMake}</p>
											)}
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
											{photo.exif.lensMake && (
												<p>{photo.exif.lensMake}</p>
											)}
											{photo.exif.lensModel && (
												<p className="text-gray-400">
													{photo.exif.lensModel}
												</p>
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

import type { AppRouter } from "@photobrain/api";
import { formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import {
	Aperture,
	Calendar,
	Camera,
	ChevronDown,
	FileImage,
	Gauge,
	ImageIcon,
	Lens,
	MapPin,
	RefreshCw,
} from "lucide-react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface MetadataPanelProps {
	photo: PhotoMetadata | null;
	className?: string;
}

interface MetadataSectionProps {
	title: string;
	icon: React.ElementType;
	defaultOpen?: boolean;
	children: React.ReactNode;
}

function MetadataSection({
	title,
	icon: Icon,
	defaultOpen = true,
	children,
}: MetadataSectionProps) {
	return (
		<Collapsible defaultOpen={defaultOpen} className="border-b border-border">
			<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent/50 transition-colors">
				<div className="flex items-center gap-2">
					<Icon className="h-3.5 w-3.5" />
					<span>{title}</span>
				</div>
				<ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
			</CollapsibleTrigger>
			<CollapsibleContent className="px-3 pb-3">{children}</CollapsibleContent>
		</Collapsible>
	);
}

function MetadataRow({
	label,
	value,
}: {
	label: string;
	value: string | number | null | undefined;
}) {
	if (value === null || value === undefined) return null;
	return (
		<div className="metadata-row">
			<span className="metadata-label">{label}</span>
			<span className="metadata-value">{value}</span>
		</div>
	);
}

export function MetadataPanel({ photo, className }: MetadataPanelProps) {
	const utils = trpc.useUtils();
	const reprocessMutation = trpc.reprocessRaw.useMutation({
		onSuccess: () => {
			utils.photos.invalidate();
		},
	});

	if (!photo) {
		return (
			<div
				className={cn(
					"flex h-full flex-col items-center justify-center text-muted-foreground",
					className,
				)}
			>
				<ImageIcon className="h-12 w-12 opacity-30 mb-3" />
				<p className="text-sm">No photo selected</p>
			</div>
		);
	}

	const hasExif = photo.exif !== null && photo.exif !== undefined;

	return (
		<ScrollArea className={cn("h-full", className)}>
			<div className="pb-4">
				{/* File Info */}
				<MetadataSection title="File" icon={FileImage}>
					<div className="space-y-0.5 pt-1">
						<MetadataRow label="Name" value={photo.name} />
						<MetadataRow label="Size" value={formatFileSize(photo.size)} />
						{photo.width && photo.height && (
							<MetadataRow
								label="Dimensions"
								value={`${photo.width} x ${photo.height}`}
							/>
						)}
						<MetadataRow label="Type" value={photo.mimeType} />
						<MetadataRow
							label="Modified"
							value={new Date(photo.modifiedAt).toLocaleDateString()}
						/>
					</div>
				</MetadataSection>

				{/* RAW File Info */}
				{photo.isRaw && (
					<MetadataSection title="RAW" icon={Camera}>
						<div className="space-y-2 pt-1">
							<div className="flex items-center gap-2">
								<span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-2xs font-semibold text-orange-400">
									{photo.rawFormat || "RAW"}
								</span>
								<span
									className={cn(
										"text-2xs font-medium",
										photo.rawStatus === "converted" && "text-green-400",
										photo.rawStatus === "failed" && "text-red-400",
										photo.rawStatus === "no_converter" && "text-yellow-400",
									)}
								>
									{photo.rawStatus === "converted"
										? "Converted"
										: photo.rawStatus === "failed"
											? "Failed"
											: photo.rawStatus === "no_converter"
												? "No Converter"
												: "Unknown"}
								</span>
							</div>
							{photo.rawError && (
								<p className="text-2xs text-red-400 bg-red-500/10 rounded px-2 py-1">
									{photo.rawError}
								</p>
							)}
							{photo.rawStatus !== "converted" && (
								<button
									onClick={() => reprocessMutation.mutate({ id: photo.id })}
									disabled={reprocessMutation.isPending}
									className="flex items-center gap-1.5 text-2xs bg-orange-600 hover:bg-orange-500 disabled:bg-muted text-white px-2 py-1 rounded transition-colors"
								>
									<RefreshCw
										className={cn(
											"h-3 w-3",
											reprocessMutation.isPending && "animate-spin",
										)}
									/>
									{reprocessMutation.isPending ? "Retrying..." : "Retry"}
								</button>
							)}
						</div>
					</MetadataSection>
				)}

				{/* Camera */}
				{hasExif && (photo.exif.cameraMake || photo.exif.cameraModel) && (
					<MetadataSection title="Camera" icon={Camera}>
						<div className="space-y-0.5 pt-1">
							<MetadataRow label="Make" value={photo.exif.cameraMake} />
							<MetadataRow label="Model" value={photo.exif.cameraModel} />
						</div>
					</MetadataSection>
				)}

				{/* Lens */}
				{hasExif && (photo.exif.lensMake || photo.exif.lensModel) && (
					<MetadataSection title="Lens" icon={Aperture}>
						<div className="space-y-0.5 pt-1">
							<MetadataRow label="Make" value={photo.exif.lensMake} />
							<MetadataRow label="Model" value={photo.exif.lensModel} />
						</div>
					</MetadataSection>
				)}

				{/* Exposure Settings */}
				{hasExif &&
					(photo.exif.iso ||
						photo.exif.aperture ||
						photo.exif.shutterSpeed ||
						photo.exif.focalLength ||
						photo.exif.exposureBias) && (
						<MetadataSection title="Settings" icon={Gauge}>
							<div className="space-y-0.5 pt-1">
								{photo.exif.focalLength && (
									<MetadataRow
										label="Focal Length"
										value={`${photo.exif.focalLength}mm`}
									/>
								)}
								<MetadataRow label="Aperture" value={photo.exif.aperture} />
								<MetadataRow label="Shutter" value={photo.exif.shutterSpeed} />
								<MetadataRow label="ISO" value={photo.exif.iso?.toString()} />
								<MetadataRow label="Exposure" value={photo.exif.exposureBias} />
							</div>
						</MetadataSection>
					)}

				{/* Date */}
				{hasExif && photo.exif.dateTaken && (
					<MetadataSection title="Date Taken" icon={Calendar}>
						<div className="pt-1">
							<p className="text-xs text-foreground">{photo.exif.dateTaken}</p>
						</div>
					</MetadataSection>
				)}

				{/* Location */}
				{hasExif &&
					(photo.exif.gpsLatitude ||
						photo.exif.gpsLongitude ||
						photo.exif.gpsAltitude) && (
						<MetadataSection title="Location" icon={MapPin}>
							<div className="space-y-0.5 pt-1">
								<MetadataRow label="Latitude" value={photo.exif.gpsLatitude} />
								<MetadataRow
									label="Longitude"
									value={photo.exif.gpsLongitude}
								/>
								{photo.exif.gpsAltitude && (
									<MetadataRow
										label="Altitude"
										value={`${photo.exif.gpsAltitude}m`}
									/>
								)}
							</div>
						</MetadataSection>
					)}

				{/* No EXIF */}
				{!hasExif && !photo.isRaw && (
					<div className="px-3 py-4 text-center text-xs text-muted-foreground">
						No metadata available
					</div>
				)}
			</div>
		</ScrollArea>
	);
}

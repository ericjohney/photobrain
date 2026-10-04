import { formatFileSize } from "@photobrain/utils";
import {
	Aperture,
	Calendar,
	Camera,
	Check,
	ChevronDown,
	FileImage,
	Flag,
	Gauge,
	ImageIcon,
	MapPin,
	ScanEye,
	Sparkles,
	Star,
	X,
	XCircle,
} from "lucide-react";
import { PhotoExportMenu } from "@/components/PhotoExportMenu";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CurationPatch } from "@/hooks/use-photo-curation";
import { JUNK_REASON_LABELS } from "@/lib/junk-review";
import { formatDuration } from "@/lib/media";
import { rawBadge } from "@/lib/raw-badge";
import { trpc } from "@/lib/trpc";
import type {
	JunkAction,
	JunkReason,
	PhotoMetadata,
	PhotoPlace,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
	PhotoCollections,
	type PhotoCollectionsProps,
} from "./PhotoCollections";
import { PhotoPlaceRow } from "./PhotoPlaceRow";
import { PhotoTags } from "./PhotoTags";

interface MetadataPanelProps {
	photo: PhotoMetadata | null;
	onFindSimilar?: () => void;
	onCurate?: (patch: CurationPatch) => void;
	/** Applies a tag chip as the library tag filter. */
	onTagSelect?: (tag: string) => void;
	/** Applies the Place row as the library country + city filter. */
	onPlaceSelect?: (place: PhotoPlace) => void;
	/** Present only when the photo has a valid location: open it on the map. */
	onShowOnMap?: () => void;
	/** Collection membership controls for the active photo. */
	collections?: Omit<PhotoCollectionsProps, "photoId">;
	/** Junk review: why the active photo is a candidate, and how to resolve it. */
	review?: {
		reasons: readonly JunkReason[];
		onResolve: (action: JunkAction) => void;
	};
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

/** RAW-section row naming the other file of a RAW+standard pair. */
function PairRow({
	pairedPhotoId,
	pairedFormat,
}: {
	pairedPhotoId: number;
	pairedFormat: string;
}) {
	const partnerQuery = trpc.photo.useQuery({ id: pairedPhotoId });
	return (
		<div data-testid="photo-pair" className="metadata-row">
			<span className="metadata-label">Pair</span>
			<span className="metadata-value" title={partnerQuery.data?.name}>
				{partnerQuery.data?.name ??
					(partnerQuery.error ? "Unavailable" : "Loading…")}{" "}
				<span className="text-muted-foreground">{pairedFormat}</span>
			</span>
		</div>
	);
}

const RATINGS = [1, 2, 3, 4, 5] as const;

/** Star rating plus pick/reject toggles; re-selecting the current value clears it. */
function CurationControls({
	photo,
	onCurate,
}: {
	photo: PhotoMetadata;
	onCurate: (patch: CurationPatch) => void;
}) {
	return (
		<div
			data-testid="curation-controls"
			className="flex items-center gap-2 border-b border-border px-3 py-2"
		>
			<span className="metadata-label text-xs">Rating</span>
			<div
				role="radiogroup"
				aria-label="Rating"
				className="flex flex-1 items-center"
			>
				{RATINGS.map((stars) => (
					<button
						key={stars}
						type="button"
						role="radio"
						aria-checked={photo.rating === stars}
						aria-label={`Rate ${stars} ${stars === 1 ? "star" : "stars"}`}
						title={`${stars} ${stars === 1 ? "star" : "stars"} (${stars})`}
						onClick={() =>
							onCurate({ rating: photo.rating === stars ? 0 : stars })
						}
						className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
					>
						<Star
							className={cn(
								"h-4 w-4",
								stars <= photo.rating && "fill-current text-yellow-400",
							)}
						/>
					</button>
				))}
			</div>
			<div className="flex items-center gap-1">
				<button
					type="button"
					aria-pressed={photo.flag === "pick"}
					aria-label="Pick"
					title="Pick (P)"
					onClick={() =>
						onCurate({ flag: photo.flag === "pick" ? null : "pick" })
					}
					className={cn(
						"rounded p-1 transition-colors hover:bg-secondary",
						photo.flag === "pick"
							? "text-green-400"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<Flag
						className={cn("h-4 w-4", photo.flag === "pick" && "fill-current")}
					/>
				</button>
				<button
					type="button"
					aria-pressed={photo.flag === "reject"}
					aria-label="Reject"
					title="Reject (X)"
					onClick={() =>
						onCurate({ flag: photo.flag === "reject" ? null : "reject" })
					}
					className={cn(
						"rounded p-1 transition-colors hover:bg-secondary",
						photo.flag === "reject"
							? "text-red-500"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					<XCircle className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
}

/** Review-mode section: the photo's junk reasons with Reject/Keep actions. */
function ReviewReasons({
	reasons,
	onResolve,
}: NonNullable<MetadataPanelProps["review"]>) {
	return (
		<div
			data-testid="review-reasons"
			className="border-b border-border px-3 py-2"
		>
			<span className="metadata-label flex items-center gap-1.5 text-xs">
				<ScanEye className="h-3.5 w-3.5" />
				Why it's here
			</span>
			<ul aria-label="Review reasons" className="mt-1.5 flex flex-wrap gap-1">
				{reasons.map((reason) => (
					<li
						key={reason}
						className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs text-primary"
					>
						{JUNK_REASON_LABELS[reason]}
					</li>
				))}
			</ul>
			<div className="mt-2 flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-7 flex-1 text-xs"
					title="Reject (X)"
					onClick={() => onResolve("reject")}
				>
					<X className="h-3.5 w-3.5" />
					Reject
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-7 flex-1 text-xs"
					title="Keep (K)"
					onClick={() => onResolve("keep")}
				>
					<Check className="h-3.5 w-3.5" />
					Keep
				</Button>
			</div>
		</div>
	);
}

export function MetadataPanel({
	photo,
	onFindSimilar,
	onCurate,
	onTagSelect,
	onPlaceSelect,
	onShowOnMap,
	collections,
	review,
	className,
}: MetadataPanelProps) {
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
	const formatBadge = rawBadge(photo);

	return (
		<ScrollArea className={cn("h-full", className)}>
			<div className="pb-4">
				{review && <ReviewReasons {...review} />}
				<div className="flex gap-2 border-b border-border px-3 py-2">
					{onFindSimilar && (
						<Button
							variant="outline"
							size="sm"
							className="flex-1"
							onClick={onFindSimilar}
							title="Find similar photos (S)"
						>
							<Sparkles className="h-4 w-4" />
							Find similar
						</Button>
					)}
					<PhotoExportMenu photo={photo} className="flex-1" />
				</div>
				{onCurate && <CurationControls photo={photo} onCurate={onCurate} />}
				{collections && (
					<PhotoCollections photoId={photo.id} {...collections} />
				)}
				{onTagSelect && <PhotoTags photoId={photo.id} onSelect={onTagSelect} />}
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
						{photo.mediaType === "video" && (
							<>
								<MetadataRow
									label="Duration"
									value={formatDuration(photo.durationMs)}
								/>
								<MetadataRow
									label="Codec"
									value={photo.videoCodec?.toUpperCase()}
								/>
							</>
						)}
						<MetadataRow label="Type" value={photo.mimeType} />
						<MetadataRow
							label="Modified"
							value={new Date(photo.modifiedAt).toLocaleDateString()}
						/>
					</div>
				</MetadataSection>

				{/* RAW File Info (RAW files and RAW+standard pairs) */}
				{formatBadge && (
					<MetadataSection title="RAW" icon={Camera}>
						<div className="space-y-2 pt-1">
							<div className="flex items-center gap-2">
								<span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-2xs font-semibold text-orange-400">
									{formatBadge.label}
								</span>
								{photo.isRaw && (
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
								)}
							</div>
							{photo.pairedPhotoId !== null && photo.pairedFormat !== null && (
								<PairRow
									key={photo.pairedPhotoId}
									pairedPhotoId={photo.pairedPhotoId}
									pairedFormat={photo.pairedFormat}
								/>
							)}
							{photo.rawError && (
								<p className="text-2xs text-red-400 bg-red-500/10 rounded px-2 py-1">
									{photo.rawError}
								</p>
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
								<PhotoPlaceRow photoId={photo.id} onSelect={onPlaceSelect} />
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
							{onShowOnMap && (
								<Button
									variant="outline"
									size="sm"
									className="mt-2 w-full"
									onClick={onShowOnMap}
								>
									<MapPin className="h-4 w-4" />
									Show on map
								</Button>
							)}
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

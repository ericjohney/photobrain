import { formatFileSize } from "@photobrain/utils";
import { Check, Copy, Flag, Loader2, Star, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatCaptureTime } from "@/lib/duplicates";
import { rawBadge } from "@/lib/raw-badge";
import { getThumbnailUrl } from "@/lib/thumbnails";
import type { DuplicateGroup, PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

interface DuplicateGroupListProps {
	groups: DuplicateGroup[];
	activePhotoId: number | undefined;
	/** Click: makes the photo active so the metadata panel shows it. */
	onPhotoActivate: (photo: PhotoMetadata) => void;
	/** Double-click: opens the photo in the loupe. */
	onPhotoOpen: (photo: PhotoMetadata) => void;
	onKeep: (group: DuplicateGroup, keepIds: number[]) => void;
	onDismiss: (group: DuplicateGroup) => void;
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
}

/** Duplicate/burst groups, one card each, with "Load more" for the next page. */
export function DuplicateGroupList({
	groups,
	activePhotoId,
	onPhotoActivate,
	onPhotoOpen,
	onKeep,
	onDismiss,
	hasMore,
	loadingMore,
	onLoadMore,
}: DuplicateGroupListProps) {
	return (
		<ScrollArea className="h-full">
			<div className="flex flex-col gap-3 p-3">
				{groups.map((group) => (
					<DuplicateGroupCard
						key={group.key}
						group={group}
						activePhotoId={activePhotoId}
						onPhotoActivate={onPhotoActivate}
						onPhotoOpen={onPhotoOpen}
						onKeep={onKeep}
						onDismiss={onDismiss}
					/>
				))}
				{hasMore && (
					<Button
						variant="outline"
						size="sm"
						className="self-center"
						disabled={loadingMore}
						onClick={onLoadMore}
					>
						{loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
						Load more
					</Button>
				)}
			</div>
		</ScrollArea>
	);
}

/**
 * One group: members side by side with the suggested keeper preselected.
 * Clicking a member toggles whether it is kept (at least one stays kept) and
 * makes it the active photo.
 */
function DuplicateGroupCard({
	group,
	activePhotoId,
	onPhotoActivate,
	onPhotoOpen,
	onKeep,
	onDismiss,
}: Omit<
	DuplicateGroupListProps,
	"groups" | "hasMore" | "loadingMore" | "onLoadMore"
> & { group: DuplicateGroup }) {
	const [keepIds, setKeepIds] = useState<ReadonlySet<number>>(
		() => new Set([group.suggestedKeeperId]),
	);
	// The key encodes membership, so the selection always refers to members.
	const keptIds = group.photos
		.filter((photo) => keepIds.has(photo.id))
		.map((photo) => photo.id);
	const rejectCount = group.photos.length - keptIds.length;

	return (
		<section
			data-testid="duplicate-group"
			data-group-key={group.key}
			aria-label={`${group.kind === "burst" ? "Burst" : "Duplicate group"} of ${group.photos.length} photos`}
			className="rounded-md border border-border bg-card"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
				<Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="font-medium">
					{group.kind === "burst" ? "Burst" : "Duplicates"}
				</span>
				<span className="text-muted-foreground">
					{group.photos.length} photos
					{group.maxDistance !== null &&
						` · up to ${group.maxDistance} ${group.maxDistance === 1 ? "bit" : "bits"} apart`}
				</span>
				<div className="flex-1" />
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					onClick={() => onDismiss(group)}
				>
					Not duplicates
				</Button>
				<Button
					size="sm"
					className="h-7 text-xs"
					disabled={rejectCount === 0}
					onClick={() => onKeep(group, keptIds)}
				>
					<Check className="h-3.5 w-3.5" />
					Keep selected, reject {rejectCount}
				</Button>
			</div>
			<div className="flex gap-2 overflow-x-auto p-2">
				{group.photos.map((photo) => {
					const isKept = keepIds.has(photo.id);
					const formatBadge = rawBadge(photo);
					return (
						<button
							key={photo.id}
							type="button"
							data-photo-id={photo.id}
							aria-pressed={isKept}
							aria-label={`Keep ${photo.name}`}
							onClick={() => {
								onPhotoActivate(photo);
								setKeepIds((current) => {
									const next = new Set(current);
									if (next.has(photo.id)) {
										// At least one member must stay kept.
										if (next.size === 1) return current;
										next.delete(photo.id);
									} else {
										next.add(photo.id);
									}
									return next;
								});
							}}
							onDoubleClick={() => onPhotoOpen(photo)}
							className={cn(
								"flex w-52 shrink-0 flex-col overflow-hidden rounded border-2 text-left transition-colors",
								isKept ? "border-primary" : "border-transparent opacity-60",
								activePhotoId === photo.id && "ring-2 ring-selection",
							)}
						>
							<div className="relative aspect-[4/3] bg-muted">
								<img
									src={getThumbnailUrl(
										photo.id,
										"medium",
										photo.thumbnailUpdatedAt,
									)}
									alt={photo.name}
									className="h-full w-full object-contain"
									loading="lazy"
									draggable={false}
								/>
								{photo.id === group.suggestedKeeperId && (
									<span
										data-testid="suggested-badge"
										className="absolute left-1 top-1 rounded bg-primary px-1 py-0.5 text-2xs font-semibold text-primary-foreground shadow-sm"
									>
										Suggested
									</span>
								)}
								{formatBadge && (
									<span className="absolute right-1 top-1 rounded bg-orange-500/90 px-1 py-0.5 text-2xs font-semibold text-white shadow-sm">
										{formatBadge.label}
									</span>
								)}
								<span
									className={cn(
										"absolute bottom-1 right-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-2xs font-semibold shadow-sm",
										isKept
											? "bg-primary text-primary-foreground"
											: "bg-black/60 text-white",
									)}
								>
									{isKept ? (
										<Check className="h-3 w-3" />
									) : (
										<X className="h-3 w-3" />
									)}
									{isKept ? "Keep" : "Reject"}
								</span>
							</div>
							<div
								data-testid="duplicate-photo-details"
								className="flex flex-col gap-0.5 px-2 py-1.5 text-2xs text-muted-foreground"
							>
								<span className="truncate text-xs text-foreground">
									{photo.name}
								</span>
								<span>
									{photo.width && photo.height
										? `${photo.width} × ${photo.height}`
										: "Unknown size"}{" "}
									· {formatFileSize(photo.size)}
								</span>
								<span className="flex items-center gap-1">
									{photo.rating > 0 ? (
										<span
											role="img"
											aria-label={`${photo.rating} ${photo.rating === 1 ? "star" : "stars"}`}
											className="flex items-center gap-0.5"
										>
											<Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
											{photo.rating}
										</span>
									) : (
										<span>Unrated</span>
									)}
									{photo.flag === "pick" && (
										<Flag
											aria-label="Pick"
											className="h-3 w-3 fill-green-400 text-green-400"
										/>
									)}
								</span>
								{photo.exif?.dateTaken && (
									<span>{formatCaptureTime(photo.exif.dateTaken)}</span>
								)}
							</div>
						</button>
					);
				})}
			</div>
		</section>
	);
}

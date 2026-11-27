import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MenuLink, Popover } from "@/components/ui/popover";
import { developableRawId } from "@/hooks/use-developed-raw";
import { useDismiss } from "@/hooks/use-dismiss";
import { EXPORT_SIZES, exportFileName } from "@/lib/export";
import { exportPhotoUrl, getDevelopedUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * "Export" dropdown: download the original or a resized JPEG of one photo;
 * videos offer only their original file.
 */
export function PhotoExportMenu({
	photo,
	className,
}: {
	photo: PhotoMetadata;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
	const isVideo = photo.mediaType === "video";
	const rawId = developableRawId(photo);
	const rawFormat = photo.isRaw
		? photo.name.split(".").pop()
		: photo.pairedFormat;
	const supportedFormat = ["RAF", "ARW", "DNG"].includes(
		rawFormat?.toUpperCase() ?? "",
	);
	const sizes = isVideo ? (["original"] as const) : EXPORT_SIZES;

	return (
		<div ref={menuRef} className={cn("relative", className)}>
			<Button
				variant="outline"
				size="sm"
				className="w-full"
				aria-haspopup="menu"
				aria-expanded={open}
				title={
					isVideo
						? "Export (Shift+D downloads the original video)"
						: "Export (Shift+D downloads JPEG, 2048 px)"
				}
				onClick={() => setOpen((current) => !current)}
			>
				<Download className="h-4 w-4" />
				Export
				<ChevronDown className="h-3.5 w-3.5 opacity-60" />
			</Button>
			{open && (
				<Popover role="menu" aria-label="Export" className="w-full min-w-48">
					{supportedFormat && rawId !== null && (
						<MenuLink
							href={`${getDevelopedUrl(rawId)}?download=1`}
							download
							onClick={() => setOpen(false)}
						>
							Full-resolution JPEG with saved edits
						</MenuLink>
					)}
					{sizes.map((size) => (
						<MenuLink
							key={size}
							href={exportPhotoUrl(photo.id, size)}
							download={exportFileName(photo.name, size)}
							onClick={() => setOpen(false)}
						>
							{size === "original"
								? `Original file (${photo.name})`
								: `Preview JPEG (${size} px)`}
						</MenuLink>
					))}
				</Popover>
			)}
		</div>
	);
}

import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDismiss } from "@/hooks/use-dismiss";
import { EXPORT_SIZES, exportFileName } from "@/lib/export";
import { exportPhotoUrl } from "@/lib/thumbnails";
import { cn } from "@/lib/utils";

/**
 * "Export" dropdown: download the original or a resized JPEG of one photo;
 * videos offer only their original file.
 */
export function PhotoExportMenu({
	photo,
	className,
}: {
	photo: { id: number; name: string; mediaType: "photo" | "video" };
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
	const isVideo = photo.mediaType === "video";
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
				<div
					role="menu"
					aria-label="Export"
					className="absolute right-0 top-full z-20 mt-1 w-full min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{sizes.map((size) => (
						<a
							key={size}
							role="menuitem"
							href={exportPhotoUrl(photo.id, size)}
							download={exportFileName(photo.name, size)}
							onClick={() => setOpen(false)}
							className="block truncate rounded px-2 py-1 text-xs hover:bg-secondary"
						>
							{size === "original"
								? `Original (${photo.name})`
								: `JPEG, ${size} px`}
						</a>
					))}
				</div>
			)}
		</div>
	);
}

import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { MenuLink, Popover } from "@/components/ui/popover";
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
				<Popover
					role="menu"
					aria-label="Export"
					className="w-full min-w-48"
				>
					{sizes.map((size) => (
						<MenuLink
							key={size}
							href={exportPhotoUrl(photo.id, size)}
							download={exportFileName(photo.name, size)}
							onClick={() => setOpen(false)}
						>
							{size === "original"
								? `Original (${photo.name})`
								: `JPEG, ${size} px`}
						</MenuLink>
					))}
				</Popover>
			)}
		</div>
	);
}

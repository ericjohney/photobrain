import { Upload } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";

/**
 * Wraps the library content: dragging files over it (when `enabled`) shows a
 * drop overlay, and dropping queues them through `onFiles`.
 */
export function UploadDropZone({
	enabled,
	onFiles,
	children,
}: {
	enabled: boolean;
	onFiles: (files: FileList) => void;
	children: ReactNode;
}) {
	const [over, setOver] = useState(false);
	// dragenter/dragleave fire for every child; count them.
	const depth = useRef(0);
	const accepts = (event: DragEvent) =>
		enabled && event.dataTransfer.types.includes("Files");

	return (
		<div
			data-testid="upload-drop-zone"
			className="relative h-full"
			onDragEnter={(event) => {
				if (!accepts(event)) return;
				event.preventDefault();
				depth.current++;
				setOver(true);
			}}
			onDragOver={(event) => {
				if (!accepts(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!accepts(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setOver(false);
			}}
			onDrop={(event) => {
				if (!accepts(event)) return;
				event.preventDefault();
				depth.current = 0;
				setOver(false);
				if (event.dataTransfer.files.length > 0) {
					onFiles(event.dataTransfer.files);
				}
			}}
		>
			{children}
			{over && (
				<div
					data-testid="upload-drop-overlay"
					className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-background/80 text-primary"
				>
					<Upload className="h-10 w-10" />
					<p className="text-sm font-medium">Drop photos to upload</p>
				</div>
			)}
		</div>
	);
}

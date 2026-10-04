import { ListChecks, Upload, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDismiss } from "@/hooks/use-dismiss";
import type { UploadItem, UploadsApi } from "@/hooks/use-uploads";
import { cn } from "@/lib/utils";

function statusText(item: UploadItem): string {
	switch (item.status) {
		case "queued":
			return "Waiting";
		case "uploading":
			return `${item.progress}%`;
		case "created":
			return "Uploaded";
		case "duplicate":
			return "Already in library";
		case "cancelled":
			return "Cancelled";
		case "failed":
		case "rejected":
			return item.message ?? "Failed";
	}
}

/**
 * Toolbar **Upload** button (multi-file picker limited to the server's
 * extensions) and the upload queue popover: per-file progress or outcome,
 * per-file Cancel, and Clear finished.
 */
export function UploadMenu({ uploads }: { uploads: UploadsApi }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const { items, queueOpen, setQueueOpen } = uploads;
	const popoverRef = useDismiss<HTMLDivElement>(queueOpen, () =>
		setQueueOpen(false),
	);
	const activeCount = items.filter(
		(item) => item.status === "queued" || item.status === "uploading",
	).length;
	const finishedCount = items.length - activeCount;
	const tooltip = uploads.enabled
		? "Upload photos"
		: uploads.config
			? "Uploads are disabled on the server"
			: "Uploads are unavailable";

	return (
		<div ref={popoverRef} className="relative flex items-center">
			<input
				ref={inputRef}
				type="file"
				multiple
				hidden
				data-testid="upload-input"
				accept={uploads.config?.extensions.join(",")}
				onChange={(event) => {
					if (event.target.files) uploads.addFiles(event.target.files);
					// Allows picking the same file again.
					event.target.value = "";
				}}
			/>
			<Tooltip>
				{/* A disabled button gets no pointer events; the span shows the tooltip. */}
				<TooltipTrigger asChild>
					<span data-testid="upload-button-wrapper" className="inline-flex">
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7"
							aria-label="Upload photos"
							disabled={!uploads.enabled}
							onClick={() => inputRef.current?.click()}
						>
							<Upload className="h-4 w-4" />
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent>{tooltip}</TooltipContent>
			</Tooltip>
			{items.length > 0 && (
				<Button
					variant="ghost"
					size="sm"
					aria-label="Upload queue"
					aria-haspopup="dialog"
					aria-expanded={queueOpen}
					title={uploads.importPending ? "Import will start shortly" : "Uploads"}
					className={cn("h-7 gap-1 px-2 text-xs", queueOpen && "bg-secondary")}
					onClick={() => setQueueOpen(!queueOpen)}
				>
					<ListChecks className="h-4 w-4" />
					{activeCount > 0 ? activeCount : items.length}
				</Button>
			)}
			{queueOpen && items.length > 0 && (
				<div
					role="dialog"
					aria-label="Uploads"
					className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
				>
					<div className="mb-1 flex items-center justify-between px-1">
						<span className="text-xs font-semibold">Uploads</span>
						<button
							type="button"
							disabled={finishedCount === 0}
							onClick={uploads.clearFinished}
							className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
						>
							Clear finished
						</button>
					</div>
					{uploads.importPending && (
						<p
							role="status"
							className="mb-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary"
						>
							Import will start shortly
						</p>
					)}
					<ul className="max-h-72 overflow-auto">
						{items.map((item) => {
							const active =
								item.status === "queued" || item.status === "uploading";
							const error =
								item.status === "failed" || item.status === "rejected";
							return (
								<li
									key={item.id}
									data-testid="upload-item"
									aria-label={item.file.name}
									className="flex flex-col gap-1 rounded px-1 py-1.5 text-xs hover:bg-secondary/50"
								>
									<div className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate">
											{item.file.name}
										</span>
										<span
											data-testid="upload-status"
											className={cn(
												"shrink-0 text-right",
												error
													? "text-destructive"
													: item.status === "created"
														? "text-green-500"
														: "text-muted-foreground",
											)}
										>
											{statusText(item)}
										</span>
										{active && (
											<button
												type="button"
												aria-label={`Cancel ${item.file.name}`}
												onClick={() => uploads.cancel(item.id)}
												className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
											>
												<X className="h-3.5 w-3.5" />
											</button>
										)}
									</div>
									{item.status === "uploading" && (
										<div
											role="progressbar"
											aria-label={`Uploading ${item.file.name}`}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={item.progress}
											className="h-1 overflow-hidden rounded-full bg-muted"
										>
											<div
												className="h-full bg-primary transition-all"
												style={{ width: `${item.progress}%` }}
											/>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}

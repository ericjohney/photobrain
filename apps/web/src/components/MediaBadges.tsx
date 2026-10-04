import { Play } from "lucide-react";
import { formatDuration, videoLabel } from "@/lib/media";
import { cn } from "@/lib/utils";

/** Video duration (`m:ss`/`h:mm:ss`) with a play glyph, labelled for assistive tech. */
export function DurationBadge({
	durationMs,
	className,
	"data-testid": testId = "duration-badge",
}: {
	durationMs: number | null;
	className?: string;
	"data-testid"?: string;
}) {
	return (
		<div
			role="img"
			aria-label={videoLabel(durationMs)}
			data-testid={testId}
			className={cn(
				"flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold tabular-nums text-white shadow-sm",
				className,
			)}
		>
			<Play aria-hidden className="h-2.5 w-2.5 fill-white" />
			<span aria-hidden>{formatDuration(durationMs)}</span>
		</div>
	);
}

/** `LIVE` marker for a still with a Live Photo motion clip. */
export function LiveBadge({ className }: { className?: string }) {
	return (
		<div
			role="img"
			aria-label="Live Photo"
			data-testid="live-badge"
			className={cn(
				"rounded bg-black/60 px-1 py-0.5 text-2xs font-semibold tracking-wide text-white shadow-sm",
				className,
			)}
		>
			<span aria-hidden>LIVE</span>
		</div>
	);
}

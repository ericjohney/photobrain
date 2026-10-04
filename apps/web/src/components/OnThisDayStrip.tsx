import { CalendarClock } from "lucide-react";
import { formatCapturedDate } from "@/lib/on-this-day";
import { getThumbnailUrl } from "@/lib/thumbnails";
import type { OnThisDayYear } from "@/lib/types";

/**
 * "On this day" cards above the library grid, one per earlier year (most
 * recent first, as the API orders them). Clicking a card filters the grid to
 * that capture date. Renders nothing without years.
 */
export function OnThisDayStrip({
	years,
	onSelect,
}: {
	years: readonly OnThisDayYear[];
	onSelect: (capturedDate: string) => void;
}) {
	if (years.length === 0) return null;
	return (
		<section
			data-testid="on-this-day"
			aria-label="On this day"
			className="shrink-0 border-b border-border px-3 pb-3 pt-2"
		>
			<h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<CalendarClock className="h-3.5 w-3.5" />
				On this day
			</h2>
			<div className="flex gap-2 overflow-x-auto pb-1">
				{years.map((year) => (
					<button
						key={year.year}
						type="button"
						data-testid="on-this-day-card"
						data-captured-date={year.capturedDate}
						onClick={() => onSelect(year.capturedDate)}
						className="group relative h-28 w-40 shrink-0 overflow-hidden rounded-md bg-muted text-left ring-inset hover:ring-1 hover:ring-thumbnail-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
					>
						<img
							src={getThumbnailUrl(
								year.cover.photoId,
								"small",
								year.cover.thumbnailUpdatedAt,
							)}
							alt=""
							className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
							loading="lazy"
							draggable={false}
						/>
						<span className="absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-black/75 to-transparent p-2 pt-6 text-white">
							<span
								data-testid="on-this-day-years-ago"
								className="text-sm font-semibold"
							>
								{year.yearsAgo === 1
									? "1 year ago"
									: `${year.yearsAgo} years ago`}
							</span>
							<span className="flex justify-between gap-2 text-2xs text-white/80">
								<span data-testid="on-this-day-date">
									{formatCapturedDate(year.capturedDate)}
								</span>
								<span data-testid="on-this-day-count">
									{year.count === 1 ? "1 photo" : `${year.count} photos`}
								</span>
							</span>
						</span>
					</button>
				))}
			</div>
		</section>
	);
}

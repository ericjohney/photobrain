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
			<h2 className="section-label mb-2 flex items-center gap-1.5">
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
						className="group relative h-28 w-44 shrink-0 overflow-hidden rounded-lg bg-secondary text-left ring-inset hover:ring-1 hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
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
						<span className="absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-overlay/80 to-transparent p-2.5 pt-8 text-overlay-foreground">
							<span
								data-testid="on-this-day-years-ago"
								className="text-sm font-semibold tracking-tight"
							>
								{year.yearsAgo === 1
									? "1 year ago"
									: `${year.yearsAgo} years ago`}
							</span>
							<span className="flex justify-between gap-2 text-2xs text-overlay-foreground/80">
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

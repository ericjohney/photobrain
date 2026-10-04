import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDismiss } from "@/hooks/use-dismiss";
import {
	adjacentCalendarMonth,
	calendarWeeks,
	capturedMonths,
	formatCalendarDay,
	formatCalendarMonth,
	initialCalendarMonth,
	localeFirstWeekday,
	weekdayLabels,
} from "@/lib/timeline";
import { cn } from "@/lib/utils";

interface TimelineCalendarProps {
	/** Photos per EXIF capture day (`YYYY-MM-DD`) in the loaded library. */
	counts: ReadonlyMap<string, number>;
	/** The active `capturedDate` filter, if any. */
	capturedDate: string | null;
	/** Applies the `capturedDate` filter for a day with photos. */
	onSelectDay: (day: string) => void;
}

const FIRST_WEEKDAY = localeFirstWeekday();
const WEEKDAY_LABELS = weekdayLabels(FIRST_WEEKDAY);

/**
 * Toolbar calendar: one month of capture days at a time, each with its photo
 * count. Days without photos are disabled and prev/next skip months without
 * photos.
 */
export function TimelineCalendar({
	counts,
	capturedDate,
	onSelectDay,
}: TimelineCalendarProps) {
	const [open, setOpen] = useState(false);
	const [month, setMonth] = useState<string | null>(null);
	const popoverRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
	const months = useMemo(() => capturedMonths(counts), [counts]);
	const weeks = useMemo(
		() => (month ? calendarWeeks(month, FIRST_WEEKDAY) : []),
		[month],
	);
	const prevMonth = month ? adjacentCalendarMonth(months, month, -1) : null;
	const nextMonth = month ? adjacentCalendarMonth(months, month, 1) : null;

	const toggle = () => {
		if (!open) setMonth(initialCalendarMonth(months, capturedDate));
		setOpen(!open);
	};

	return (
		<div ref={popoverRef} className="relative">
			{/* A native title, not a Tooltip: the popover itself sits under the button. */}
			<Button
				variant="ghost"
				size="icon"
				aria-label="Calendar"
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Calendar"
				className={cn("h-7 w-7", open && "bg-secondary")}
				onClick={toggle}
			>
				<CalendarDays className="h-4 w-4" />
			</Button>
			{open && (
				<div
					role="dialog"
					aria-label="Capture calendar"
					data-testid="timeline-calendar"
					className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
				>
					{month === null ? (
						<p className="px-1 py-2 text-xs text-muted-foreground">
							No photos with a capture date
						</p>
					) : (
						<>
							<div className="mb-1 flex items-center justify-between">
								<button
									type="button"
									aria-label="Previous month"
									disabled={prevMonth === null}
									onClick={() => setMonth(prevMonth)}
									className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
								>
									<ChevronLeft className="h-4 w-4" />
								</button>
								<span
									data-testid="calendar-month"
									aria-live="polite"
									className="text-xs font-semibold"
								>
									{formatCalendarMonth(month)}
								</span>
								<button
									type="button"
									aria-label="Next month"
									disabled={nextMonth === null}
									onClick={() => setMonth(nextMonth)}
									className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
								>
									<ChevronRight className="h-4 w-4" />
								</button>
							</div>
							<div
								aria-hidden="true"
								className="grid grid-cols-7 gap-0.5 pb-0.5 text-center text-2xs text-muted-foreground"
							>
								{WEEKDAY_LABELS.map((label) => (
									<span key={label}>{label}</span>
								))}
							</div>
							<div className="grid grid-cols-7 gap-0.5">
								{weeks.flat().map((day, index) => {
									if (day === null) {
										// biome-ignore lint/suspicious/noArrayIndexKey: padding cells have no identity
										return <span key={`pad-${index}`} />;
									}
									const count = counts.get(day) ?? 0;
									const selected = day === capturedDate;
									return (
										<button
											key={day}
											type="button"
											data-day={day}
											disabled={count === 0}
											aria-pressed={selected}
											aria-label={`${formatCalendarDay(day)}: ${count} ${count === 1 ? "photo" : "photos"}`}
											onClick={() => {
												setOpen(false);
												onSelectDay(day);
											}}
											className={cn(
												"flex h-8 flex-col items-center justify-center rounded text-xs leading-none transition-colors",
												"disabled:pointer-events-none disabled:text-muted-foreground/40",
												selected
													? "bg-primary text-primary-foreground"
													: "hover:bg-secondary",
											)}
										>
											<span>{Number(day.slice(8, 10))}</span>
											{count > 0 && (
												<span
													data-testid="calendar-day-count"
													className={cn(
														"mt-0.5 text-[9px] tabular-nums",
														selected
															? "text-primary-foreground/80"
															: "text-primary",
													)}
												>
													{count}
												</span>
											)}
										</button>
									);
								})}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}

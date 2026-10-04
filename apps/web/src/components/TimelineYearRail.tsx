import { type RefObject, useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface TimelineYearRailProps {
	/** Distinct section years in display order. */
	years: number[];
	/** The grid's scrolling element, holding `[data-section-year]` sections. */
	viewportRef: RefObject<HTMLDivElement | null>;
}

/** Year of the last section whose top has reached the viewport's top edge. */
function yearAtTop(viewport: HTMLElement): number | null {
	const top = viewport.getBoundingClientRect().top;
	let year: number | null = null;
	for (const section of viewport.querySelectorAll<HTMLElement>(
		"[data-section-id]",
	)) {
		// One pixel of slack: a jumped-to section sits exactly at the top.
		if (section.getBoundingClientRect().top > top + 1) break;
		const value = section.dataset.sectionYear;
		year = value === undefined ? null : Number(value);
	}
	return year;
}

/**
 * Narrow year list at the grid's right edge. Clicking a year scrolls its first
 * section to the top; the year at the top is highlighted while scrolling.
 * Scroll tracking is rAF-throttled and only re-renders this rail.
 */
export function TimelineYearRail({
	years,
	viewportRef,
}: TimelineYearRailProps) {
	const [currentYear, setCurrentYear] = useState<number | null>(null);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			// Above the first section (top padding) counts as the first year.
			setCurrentYear(yearAtTop(viewport) ?? years[0] ?? null);
		};
		const onScroll = () => {
			if (frame === 0) frame = requestAnimationFrame(update);
		};
		update();
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			viewport.removeEventListener("scroll", onScroll);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [viewportRef, years]);

	const jumpTo = useCallback(
		(year: number) => {
			const viewport = viewportRef.current;
			const section = viewport?.querySelector<HTMLElement>(
				`[data-section-year="${year}"]`,
			);
			if (!viewport || !section) return;
			viewport.scrollTop +=
				section.getBoundingClientRect().top -
				viewport.getBoundingClientRect().top;
		},
		[viewportRef],
	);

	return (
		<nav
			aria-label="Jump to year"
			data-testid="timeline-year-rail"
			className="flex w-12 flex-shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto border-l border-border py-1"
		>
			{years.map((year) => {
				const current = year === currentYear;
				return (
					<button
						key={year}
						type="button"
						aria-current={current ? "true" : undefined}
						onClick={() => jumpTo(year)}
						className={cn(
							"mx-1 rounded px-1 py-0.5 text-center text-2xs tabular-nums transition-colors",
							current
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-secondary hover:text-foreground",
						)}
					>
						{year}
					</button>
				);
			})}
		</nav>
	);
}

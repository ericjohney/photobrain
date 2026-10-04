import { useEffect, useState } from "react";
import { localDateString, msUntilNextLocalDay } from "@/lib/on-this-day";
import { trpc } from "@/lib/trpc";

/**
 * The browser's local calendar date (`YYYY-MM-DD`), re-read at local midnight
 * and whenever the window regains focus or becomes visible, so a page left
 * open across midnight (or a sleeping laptop) asks for the new day.
 */
export function useLocalToday() {
	const [today, setToday] = useState(() => localDateString(new Date()));

	useEffect(() => {
		let timer: number | undefined;
		const refresh = () => {
			const now = new Date();
			setToday(localDateString(now));
			window.clearTimeout(timer);
			// A second past midnight so the new date is already current.
			timer = window.setTimeout(refresh, msUntilNextLocalDay(now) + 1000);
		};
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") refresh();
		};
		refresh();
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);

	return today;
}

/**
 * "On this day" year groups for the browser's local date. Only fetched while
 * the dashboard shows the whole library (`enabled`).
 */
export function useOnThisDay(enabled: boolean) {
	const date = useLocalToday();
	const query = trpc.onThisDay.useQuery({ date }, { enabled });
	return { date, years: enabled ? (query.data?.years ?? []) : [] };
}

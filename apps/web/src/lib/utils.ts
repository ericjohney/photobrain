import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Formats a `YYYY-MM` filter value as e.g. "June 2024". */
export function formatMonthLabel(dateMonth: string) {
	const [year, month] = dateMonth.split("-");
	return new Date(Number(year), Number(month) - 1).toLocaleDateString(
		"en-US",
		{ year: "numeric", month: "long" },
	);
}

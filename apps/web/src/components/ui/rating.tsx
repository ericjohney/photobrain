import { Flag, Star, XCircle } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * Five-star rating as a `radiogroup`. Choosing the current rating clears it
 * (`onChange(0)`).
 */
export function StarRating({
	value,
	onChange,
	label = "Rating",
	className,
}: {
	value: number;
	onChange: (rating: number) => void;
	label?: string;
	className?: string;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={cn("flex items-center", className)}
		>
			{RATINGS.map((stars) => (
				<button
					key={stars}
					type="button"
					role="radio"
					aria-checked={value === stars}
					aria-label={`Rate ${stars} ${stars === 1 ? "star" : "stars"}`}
					title={`${stars} ${stars === 1 ? "star" : "stars"} (${stars})`}
					onClick={() => onChange(value === stars ? 0 : stars)}
					className="rounded p-0.5 text-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<Star
						className={cn(
							"h-4 w-4",
							stars <= value && "fill-current text-star",
						)}
					/>
				</button>
			))}
		</div>
	);
}

function FlagToggle({
	pressed,
	tone,
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	pressed: boolean;
	tone: "pick" | "reject";
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			className={cn(
				"rounded-md p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				pressed
					? tone === "pick"
						? "bg-pick/15 text-pick"
						: "bg-reject/15 text-reject"
					: "text-subtle hover:bg-secondary hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

/** Pick toggle (flag icon, mint when on). */
export function PickToggle({
	pressed,
	onToggle,
}: {
	pressed: boolean;
	onToggle: () => void;
}) {
	return (
		<FlagToggle
			tone="pick"
			pressed={pressed}
			aria-label="Pick"
			title="Pick (P)"
			onClick={onToggle}
		>
			<Flag className={cn("h-4 w-4", pressed && "fill-current")} />
		</FlagToggle>
	);
}

/** Reject toggle (circled ✕, red when on). */
export function RejectToggle({
	pressed,
	onToggle,
}: {
	pressed: boolean;
	onToggle: () => void;
}) {
	return (
		<FlagToggle
			tone="reject"
			pressed={pressed}
			aria-label="Reject"
			title="Reject (X)"
			onClick={onToggle}
		>
			<XCircle className="h-4 w-4" />
		</FlagToggle>
	);
}

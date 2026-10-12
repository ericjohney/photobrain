import { cva, type VariantProps } from "class-variance-authority";
import { Flag, Play, Star, X } from "lucide-react";
import type { HTMLAttributes } from "react";
import { formatDuration, videoLabel } from "@/lib/media";
import { cn } from "@/lib/utils";

/**
 * Small label chip. `overlay` sits on photos (theme-independent glass),
 * `raw` marks RAW / RAW+JPEG files, `accent`/`soft*` sit on panels.
 */
export const badgeVariants = cva(
	"inline-flex items-center gap-1 whitespace-nowrap font-semibold",
	{
		variants: {
			variant: {
				overlay:
					"bg-overlay/60 text-overlay-foreground shadow-sm backdrop-blur-sm",
				raw: "bg-raw text-raw-foreground shadow-sm",
				accent: "bg-primary text-primary-foreground shadow-sm",
				pick: "bg-pick text-pick-foreground shadow-sm",
				"soft-raw": "bg-raw/15 text-raw",
				"soft-accent": "bg-primary/15 text-primary",
			},
			size: {
				default: "rounded-md px-1.5 py-0.5 text-2xs",
				/** Filmstrip thumbnails. */
				xs: "rounded-sm px-0.5 text-[8px] leading-3",
			},
		},
		defaultVariants: { variant: "overlay", size: "default" },
	},
);

export interface BadgeProps
	extends HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
	return (
		<span
			className={cn(badgeVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

/** RAW / RAW+JPEG pair badge (`rawBadge(photo)`): `label`, or `compact` at `xs`. */
export function RawBadge({
	badge,
	size,
	className,
	...props
}: Omit<BadgeProps, "variant" | "children"> & { badge: { label: string; compact: string } }) {
	return (
		<Badge
			variant="raw"
			size={size}
			title={size === "xs" ? badge.label : undefined}
			className={className}
			{...props}
		>
			{size === "xs" ? badge.compact : badge.label}
		</Badge>
	);
}

/** Star count, labelled for assistive tech ("3 stars"). */
export function RatingStars({
	rating,
	className,
}: {
	rating: number;
	className?: string;
}) {
	return (
		<span
			role="img"
			aria-label={`${rating} ${rating === 1 ? "star" : "stars"}`}
			className={cn("flex items-center gap-0.5", className)}
		>
			<Star className="h-2.5 w-2.5 fill-star text-star" />
			{rating}
		</span>
	);
}

/** Pick / Reject mark for a photo's flag; nothing when unflagged. */
export function FlagMark({ flag }: { flag: "pick" | "reject" | null }) {
	if (flag === "pick") {
		return <Flag aria-label="Pick" className="h-3 w-3 fill-pick text-pick" />;
	}
	if (flag === "reject") {
		return (
			<X aria-label="Rejected" className="h-3 w-3 stroke-[3] text-reject" />
		);
	}
	return null;
}

/** Video duration (`m:ss`/`h:mm:ss`) with a play glyph, labelled for assistive tech. */
export function DurationBadge({
	durationMs,
	size,
	className,
	"data-testid": testId = "duration-badge",
}: {
	durationMs: number | null;
	size?: BadgeProps["size"];
	className?: string;
	"data-testid"?: string;
}) {
	return (
		<Badge
			role="img"
			aria-label={videoLabel(durationMs)}
			data-testid={testId}
			size={size}
			className={cn("gap-0.5 tabular-nums", className)}
		>
			<Play aria-hidden className="h-2.5 w-2.5 fill-current" />
			<span aria-hidden>{formatDuration(durationMs)}</span>
		</Badge>
	);
}

/** `LIVE` marker for a still with a Live Photo motion clip. */
export function LiveBadge({ className }: { className?: string }) {
	return (
		<Badge
			role="img"
			aria-label="Live Photo"
			data-testid="live-badge"
			className={cn("tracking-wide", className)}
		>
			<span aria-hidden>LIVE</span>
		</Badge>
	);
}

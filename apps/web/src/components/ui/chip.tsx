import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const chipBase =
	"inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-medium text-primary";

/** Static accent chip (collection membership, review reasons). */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
	return <span className={cn(chipBase, className)} {...props} />;
}

/** Clickable chip (tags that apply a filter). */
export function ChipButton({
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type={type}
			className={cn(
				chipBase,
				"transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				className,
			)}
			{...props}
		/>
	);
}

/** Active-filter chip with a clear (✕) button. */
export function RemovableChip({
	icon,
	children,
	clearLabel,
	onClear,
	className,
	...props
}: HTMLAttributes<HTMLSpanElement> & {
	icon?: ReactNode;
	clearLabel: string;
	onClear: () => void;
}) {
	return (
		<span
			className={cn(chipBase, "py-0.5 pr-0.5 text-xs", className)}
			{...props}
		>
			{icon}
			{children}
			<button
				type="button"
				aria-label={clearLabel}
				onClick={onClear}
				className="rounded-full p-0.5 hover:bg-primary/20"
			>
				<X className="h-3 w-3" />
			</button>
		</span>
	);
}

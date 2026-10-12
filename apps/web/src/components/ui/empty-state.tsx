import { Loader2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Centered placeholder for an empty view: a large muted icon, a title, and optional detail. */
export function EmptyState({
	icon,
	title,
	children,
	className,
	...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
	icon?: ReactNode;
	title?: ReactNode;
	/** Detail text or actions under the title. */
	children?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex h-full flex-col items-center justify-center px-6 text-center text-subtle",
				className,
			)}
			{...props}
		>
			{icon && (
				<span className="mb-4 text-subtle/50 [&_svg]:h-14 [&_svg]:w-14">
					{icon}
				</span>
			)}
			{title && <p className="text-sm font-medium">{title}</p>}
			{children && <div className="mt-1 text-xs">{children}</div>}
		</div>
	);
}

/** Centered loading spinner with an optional label. */
export function Spinner({
	label,
	className,
}: {
	label?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-full flex-col items-center justify-center gap-3",
				className,
			)}
		>
			<Loader2 className="h-8 w-8 animate-spin text-primary" />
			{label && <p className="text-sm text-muted-foreground">{label}</p>}
		</div>
	);
}

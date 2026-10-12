import {
	type ButtonHTMLAttributes,
	forwardRef,
	type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** Classes for a selectable sidebar row; `NavRow` uses them, custom rows may too. */
export function navRowClasses(selected: boolean | undefined) {
	return cn(
		"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
		selected
			? "bg-primary/15 text-foreground hover:bg-primary/20"
			: "hover:bg-secondary",
	);
}

interface NavRowProps
	extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
	icon?: ReactNode;
	label: ReactNode;
	/** Trailing count or glyph, tinted with the selection. */
	trailing?: ReactNode;
	trailingProps?: { "data-testid"?: string; className?: string };
	selected?: boolean;
	/** Nesting depth; each level indents 16 px. */
	indent?: number;
}

/**
 * Sidebar navigation row (catalog, folders, collections, smart albums,
 * filters): icon, label, and a trailing count. Selection is the soft accent.
 * State attributes (`aria-pressed`, `aria-current`) are left to the caller.
 */
export const NavRow = forwardRef<HTMLButtonElement, NavRowProps>(
	(
		{
			icon,
			label,
			trailing,
			trailingProps,
			selected,
			indent = 0,
			className,
			style,
			type = "button",
			...props
		},
		ref,
	) => (
		<button
			ref={ref}
			type={type}
			className={cn(navRowClasses(selected), className)}
			style={indent ? { paddingLeft: 8 + indent * 16, ...style } : style}
			{...props}
		>
			{icon !== undefined && (
				<span
					className={cn(
						"flex flex-shrink-0 [&_svg]:h-4 [&_svg]:w-4",
						selected ? "text-primary" : "text-subtle",
					)}
				>
					{icon}
				</span>
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{trailing !== undefined && trailing !== null && (
				<span
					{...trailingProps}
					className={cn(
						"flex-shrink-0 text-xs tabular-nums",
						selected ? "text-primary" : "text-subtle",
						trailingProps?.className,
					)}
				>
					{trailing}
				</span>
			)}
		</button>
	),
);
NavRow.displayName = "NavRow";

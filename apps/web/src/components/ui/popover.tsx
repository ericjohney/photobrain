import { cva, type VariantProps } from "class-variance-authority";
import { Ellipsis } from "lucide-react";
import {
	type AnchorHTMLAttributes,
	type ButtonHTMLAttributes,
	forwardRef,
	type HTMLAttributes,
	type LiHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Floating panel anchored below a `relative` trigger wrapper (menus,
 * listboxes, small dialogs). Pair with `useDismiss` for outside-click and
 * Escape. Width comes from `className` (e.g. `w-44`).
 */
export const popoverVariants = cva(
	"absolute top-full mt-1 rounded-md border border-border bg-popover text-left text-popover-foreground shadow-md",
	{
		variants: {
			align: { start: "left-0", end: "right-0" },
			padding: { menu: "z-20 p-1", panel: "z-30 p-2" },
		},
		defaultVariants: { align: "end", padding: "menu" },
	},
);

type PopoverProps = HTMLAttributes<HTMLElement> &
	VariantProps<typeof popoverVariants> & {
		/** Render as a list (`ul`) for listboxes. */
		as?: "div" | "ul";
	};

export const Popover = forwardRef<HTMLElement, PopoverProps>(
	({ className, align, padding, as = "div", ...props }, ref) => {
		const Comp = as;
		return (
			<Comp
				// biome-ignore lint/suspicious/noExplicitAny: shared ref for div/ul
				ref={ref as any}
				className={cn(popoverVariants({ align, padding }), className)}
				{...props}
			/>
		);
	},
);
Popover.displayName = "Popover";

/** Row inside a `Popover`: menu items, listbox options, popover actions. */
export const menuItemVariants = cva(
	"flex w-full cursor-pointer items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none",
	{
		variants: {
			tone: { default: "", destructive: "text-destructive" },
			highlighted: { true: "bg-secondary", false: "" },
		},
		defaultVariants: { tone: "default", highlighted: false },
	},
);

type MenuItemVariants = VariantProps<typeof menuItemVariants>;

export const MenuItem = forwardRef<
	HTMLButtonElement,
	ButtonHTMLAttributes<HTMLButtonElement> & MenuItemVariants
>(({ className, tone, highlighted, type = "button", ...props }, ref) => (
	<button
		ref={ref}
		type={type}
		role="menuitem"
		className={cn(menuItemVariants({ tone, highlighted }), className)}
		{...props}
	/>
));
MenuItem.displayName = "MenuItem";

/** A menu item that is a link (e.g. a `download` anchor). */
export function MenuLink({
	className,
	tone,
	highlighted,
	...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & MenuItemVariants) {
	return (
		<a
			role="menuitem"
			className={cn(
				menuItemVariants({ tone, highlighted }),
				"block",
				className,
			)}
			{...props}
		/>
	);
}

/** A `role="option"` row inside a `Popover as="ul" role="listbox"`. */
export function MenuOption({
	className,
	tone,
	highlighted,
	...props
}: LiHTMLAttributes<HTMLLIElement> & MenuItemVariants) {
	return (
		<li
			role="option"
			className={cn(menuItemVariants({ tone, highlighted }), className)}
			{...props}
		/>
	);
}

/**
 * "⋯" button that opens a row's action menu. Hidden until the row (a `group`)
 * is hovered or the button is focused; stays visible while the menu is open.
 */
export function RowActionsTrigger({
	open,
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { open: boolean }) {
	return (
		<button
			type="button"
			aria-haspopup="menu"
			aria-expanded={open}
			className={cn(
				"rounded p-0.5 text-subtle transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
				className,
			)}
			{...props}
		>
			<Ellipsis className="h-3.5 w-3.5" />
		</button>
	);
}

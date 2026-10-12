import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/90",
				destructive: "bg-reject/15 text-reject hover:bg-reject/25",
				outline:
					"border border-input bg-transparent hover:bg-secondary hover:text-foreground",
				secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
				/** Toggles: `aria-pressed="true"` shows the soft accent automatically. */
				ghost:
					"text-muted-foreground hover:bg-secondary hover:text-foreground aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/20 aria-pressed:hover:text-primary",
				link: "text-primary underline-offset-4 hover:underline",
				/** Translucent control drawn over a photo (loupe). */
				glass:
					"bg-overlay/45 text-overlay-foreground backdrop-blur-md hover:bg-overlay/65",
				/** Same, inside an existing glass group (no extra background). */
				"glass-ghost":
					"text-overlay-foreground hover:bg-overlay-foreground/15 hover:text-overlay-foreground",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3 text-xs",
				lg: "h-10 rounded-md px-8",
				/** Toolbar and panel actions. */
				xs: "h-7 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
				icon: "h-9 w-9",
				/** Toolbar icon buttons. */
				"icon-sm": "h-7 w-7",
				/** Inline row actions (menus, clear, add). */
				"icon-xs": "h-5 w-5 rounded [&_svg]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				className={cn(buttonVariants({ variant, size, className }))}
				ref={ref}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { Button, buttonVariants };

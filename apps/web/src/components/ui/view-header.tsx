import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Round ✕ button that closes, clears, or leaves something. Needs an `aria-label`. */
export function CloseButton({
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
	return (
		<button
			type={type}
			className={cn(
				"flex-shrink-0 rounded-full p-0.5 text-subtle transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				className,
			)}
			{...props}
		>
			<X className="h-3.5 w-3.5" />
		</button>
	);
}

/**
 * Bar above the grid naming the current view or scope (search results,
 * collection, person, smart album, Review, Duplicates, People): icon, title,
 * optional meta and controls, and an exit (✕) button.
 */
export function ViewHeader({
	icon,
	title,
	meta,
	children,
	onExit,
	exitLabel,
	titleAs: Title = "h2",
	bordered = true,
	className,
	...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
	icon?: ReactNode;
	title: ReactNode;
	/** Secondary text after the title (counts, "Smart album"). */
	meta?: ReactNode;
	/** Controls between the title and the exit button (right-aligned). */
	children?: ReactNode;
	onExit?: () => void;
	exitLabel?: string;
	/** `span` when the title is a sentence rather than a heading. */
	titleAs?: "h2" | "span";
	/** False inside a wrapper that draws its own bottom border (header + banner). */
	bordered?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 px-3 py-1.5 text-sm",
				bordered && "border-b border-border",
				className,
			)}
			{...props}
		>
			{icon && (
				<span className="flex flex-shrink-0 text-subtle [&_svg]:h-3.5 [&_svg]:w-3.5">
					{icon}
				</span>
			)}
			<Title
				className={cn(
					"min-w-0 truncate",
					Title === "h2" && "font-semibold",
					!meta && !children && "flex-1",
				)}
			>
				{title}
			</Title>
			{meta !== undefined && (
				<span className={cn("text-xs text-subtle", !children && "flex-1")}>
					{meta}
				</span>
			)}
			{children && (
				<div className="flex flex-1 items-center gap-2">{children}</div>
			)}
			{onExit && exitLabel && (
				<CloseButton aria-label={exitLabel} onClick={onExit} />
			)}
		</div>
	);
}

/** Full-width error strip under a header, with an optional dismiss button. */
export function AlertBanner({
	children,
	onDismiss,
	className,
}: {
	children: ReactNode;
	onDismiss?: () => void;
	className?: string;
}) {
	return (
		<div
			role="alert"
			className={cn(
				"flex items-center gap-2 bg-destructive/10 px-3 py-1 text-xs text-destructive",
				className,
			)}
		>
			<span className="flex-1">{children}</span>
			{onDismiss && (
				<CloseButton
					aria-label="Dismiss error"
					onClick={onDismiss}
					className="text-destructive hover:bg-destructive/20 hover:text-destructive"
				/>
			)}
		</div>
	);
}

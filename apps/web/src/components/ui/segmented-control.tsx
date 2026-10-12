import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T> {
	value: T;
	label: ReactNode;
}

interface SegmentedControlProps<T> {
	/** Accessible name of the radio group. */
	label: string;
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	/** `sm` fits toolbars (28 px tall); `md` is the default inline size. */
	size?: "sm" | "md";
	/** Stretch to the container, splitting the width between options. */
	fill?: boolean;
	className?: string;
}

/**
 * Single-choice segmented control: a `radiogroup` of `radio` buttons with
 * roving focus and Left/Right arrow keys, like a native radio group.
 */
export function SegmentedControl<T>({
	label,
	options,
	value,
	onChange,
	size = "md",
	fill = false,
	className,
}: SegmentedControlProps<T>) {
	const selected = options.findIndex((option) => option.value === value);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (step === 0 || options.length === 0) return;
		event.preventDefault();
		event.stopPropagation();
		const index =
			(Math.max(selected, 0) + step + options.length) % options.length;
		onChange(options[index].value);
		event.currentTarget
			.querySelectorAll<HTMLButtonElement>('[role="radio"]')
			[index]?.focus();
	};

	return (
		<div
			role="radiogroup"
			aria-label={label}
			onKeyDown={handleKeyDown}
			className={cn(
				"flex items-center gap-0.5 rounded-md border border-border bg-well p-0.5",
				size === "sm" && "h-7",
				className,
			)}
		>
			{options.map((option, index) => {
				const checked = index === selected;
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: options are a fixed, ordered list
						key={index}
						type="button"
						role="radio"
						aria-checked={checked}
						tabIndex={checked || (selected === -1 && index === 0) ? 0 : -1}
						onClick={() => onChange(option.value)}
						className={cn(
							"flex items-center justify-center gap-1 whitespace-nowrap rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
							size === "sm" ? "h-full" : "py-0.5",
							fill && "flex-auto px-1.5",
							checked
								? "bg-secondary text-foreground shadow-sm"
								: "text-subtle hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

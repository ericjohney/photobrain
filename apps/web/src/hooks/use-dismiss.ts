import { useEffect, useRef } from "react";

/**
 * Closes a lightweight popover/menu on an outside pointer press or `Escape`.
 * Returns the ref for the element that contains both the trigger and the
 * floating content, so pressing the trigger does not count as "outside".
 */
export function useDismiss<T extends HTMLElement>(
	open: boolean,
	onDismiss: () => void,
) {
	const ref = useRef<T>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) {
				onDismissRef.current();
			}
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onDismissRef.current();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	return ref;
}

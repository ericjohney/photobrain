import { useEffect } from "react";
import type { ViewMode } from "./use-library-state";

interface KeyboardShortcutsOptions {
	viewMode: ViewMode;
	setViewMode: (mode: ViewMode) => void;
	toggleAllPanels: () => void;
	toggleFilmstrip: () => void;
	navigatePhoto: (direction: "prev" | "next") => void;
	clearSelection: () => void;
	selectAll: () => void;
	hasActivePhoto: boolean;
	enabled?: boolean;
}

export function useKeyboardShortcuts({
	viewMode,
	setViewMode,
	toggleAllPanels,
	toggleFilmstrip,
	navigatePhoto,
	clearSelection,
	selectAll,
	hasActivePhoto,
	enabled = true,
}: KeyboardShortcutsOptions) {
	useEffect(() => {
		if (!enabled) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			// Ignore if typing in an input
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement
			) {
				return;
			}

			// Check for modifier keys
			const isCtrlOrCmd = e.ctrlKey || e.metaKey;

			switch (e.key.toLowerCase()) {
				// View mode shortcuts
				case "g":
					if (!isCtrlOrCmd) {
						e.preventDefault();
						setViewMode("grid");
					}
					break;

				case "e":
					if (!isCtrlOrCmd && hasActivePhoto) {
						e.preventDefault();
						setViewMode("loupe");
					}
					break;

				// Panel shortcuts
				case "tab":
					e.preventDefault();
					toggleAllPanels();
					break;

				case " ":
					if (e.shiftKey) {
						e.preventDefault();
						toggleFilmstrip();
					}
					break;

				// Navigation
				case "arrowleft":
					if (viewMode === "loupe" || hasActivePhoto) {
						e.preventDefault();
						navigatePhoto("prev");
					}
					break;

				case "arrowright":
					if (viewMode === "loupe" || hasActivePhoto) {
						e.preventDefault();
						navigatePhoto("next");
					}
					break;

				// Selection
				case "escape":
					e.preventDefault();
					if (viewMode === "loupe") {
						setViewMode("grid");
					} else {
						clearSelection();
					}
					break;

				case "a":
					if (isCtrlOrCmd) {
						e.preventDefault();
						selectAll();
					}
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		enabled,
		viewMode,
		setViewMode,
		toggleAllPanels,
		toggleFilmstrip,
		navigatePhoto,
		clearSelection,
		selectAll,
		hasActivePhoto,
	]);
}

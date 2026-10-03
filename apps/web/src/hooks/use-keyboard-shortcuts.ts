import { useEffect } from "react";
import type { JunkAction } from "@/lib/types";
import type { ViewMode } from "./use-library-state";
import type { CurationPatch } from "./use-photo-curation";

interface KeyboardShortcutsOptions {
	viewMode: ViewMode;
	setViewMode: (mode: ViewMode) => void;
	toggleAllPanels: () => void;
	toggleFilmstrip: () => void;
	navigatePhoto: (direction: "prev" | "next") => void;
	hasActivePhoto: boolean;
	/** Enter similar-photos mode for the active photo (`S`). */
	findSimilar: () => void;
	/** Exit similar-photos mode from the grid (`Escape`); null when inactive. */
	exitSimilar: (() => void) | null;
	/** Rate or flag the active photo (`0`-`5`, `P`, `X`, `U`). */
	curateActivePhoto: (patch: CurationPatch) => void;
	/** Toggle the active photo in the last-used collection (`B`); null when none. */
	toggleLastUsedCollection: (() => void) | null;
	/** In Review: resolve the active photo (`X` reject, `K` keep); null outside Review. */
	resolveReviewPhoto: ((action: JunkAction) => void) | null;
	enabled?: boolean;
}

export function useKeyboardShortcuts({
	viewMode,
	setViewMode,
	toggleAllPanels,
	toggleFilmstrip,
	navigatePhoto,
	hasActivePhoto,
	findSimilar,
	exitSimilar,
	curateActivePhoto,
	toggleLastUsedCollection,
	resolveReviewPhoto,
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

			// Lightroom culling: 0-5 rate, P pick, X reject, U unflag.
			if (hasActivePhoto && !isCtrlOrCmd && !e.altKey) {
				const key = e.key.toLowerCase();
				// Review: X/K resolve the candidate instead of plain flagging.
				if (resolveReviewPhoto && (key === "x" || key === "k")) {
					e.preventDefault();
					resolveReviewPhoto(key === "x" ? "reject" : "keep");
					return;
				}
				if (/^[0-5]$/.test(e.key)) {
					e.preventDefault();
					curateActivePhoto({ rating: Number(e.key) });
					return;
				}
				if (key === "p" || key === "x" || key === "u") {
					e.preventDefault();
					curateActivePhoto({
						flag: key === "p" ? "pick" : key === "x" ? "reject" : null,
					});
					return;
				}
			}

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

				case "s":
					if (!isCtrlOrCmd && hasActivePhoto) {
						e.preventDefault();
						findSimilar();
					}
					break;

				case "b":
					if (
						!isCtrlOrCmd &&
						!e.altKey &&
						hasActivePhoto &&
						toggleLastUsedCollection
					) {
						e.preventDefault();
						toggleLastUsedCollection();
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

				case "escape":
					if (viewMode === "loupe") {
						e.preventDefault();
						setViewMode("grid");
					} else if (exitSimilar) {
						e.preventDefault();
						exitSimilar();
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
		hasActivePhoto,
		findSimilar,
		exitSimilar,
		curateActivePhoto,
		toggleLastUsedCollection,
		resolveReviewPhoto,
	]);
}

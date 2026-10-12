import type { Locator, Page } from "@playwright/test";

/** Breadcrumbs, title, filter chips, and view controls above the content. */
export function appHeader(page: Page): Locator {
	return page.getByTestId("app-header");
}

/** The scope path, e.g. Library / photos / 2024. */
export function breadcrumb(page: Page): Locator {
	return appHeader(page).getByRole("navigation", { name: "Breadcrumb" });
}

/** The "+ Filter" popover. */
export function filtersDialog(page: Page): Locator {
	return page.getByRole("dialog", { name: "Filters" });
}

/** Opens "+ Filter" and optionally picks a category (Type is the default). */
export async function openFilters(page: Page, category?: string) {
	const dialog = filtersDialog(page);
	if (!(await dialog.isVisible())) {
		await appHeader(page)
			.getByRole("button", { name: "Filter", exact: true })
			.click();
	}
	if (category) {
		await dialog.getByRole("button", { name: category }).first().click();
	}
	return dialog;
}

/** "Clear all" in the filter row; present only while filters are active. */
export function clearAllFilters(page: Page): Locator {
	return appHeader(page).getByRole("button", { name: "Clear all" });
}

export function saveSmartAlbumButton(page: Page): Locator {
	return appHeader(page).getByRole("button", { name: "Save as Smart Album…" });
}

/** A radio in the filter popover's Type / Rating / Flag categories (opens it as needed). */
export async function filterRadio(
	page: Page,
	category: "Type" | "Rating" | "Flag",
	name: string,
): Promise<Locator> {
	const dialog = await openFilters(page, category);
	const group = {
		Type: "Photo type",
		Rating: "Minimum rating",
		Flag: "Flag",
	}[category];
	return dialog
		.getByRole("radiogroup", { name: group })
		.getByRole("radio", { name, exact: true });
}

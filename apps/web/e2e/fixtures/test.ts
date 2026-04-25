import { test as base, expect } from "@playwright/test";
import { type HandlerOverrides, installTrpcHandlers } from "./handlers";

type Fixtures = {
	mockBackend: (overrides?: HandlerOverrides) => Promise<void>;
};

export const test = base.extend<Fixtures>({
	mockBackend: async ({ page }, use) => {
		let installed = false;
		const fn = async (overrides: HandlerOverrides = {}) => {
			if (installed) throw new Error("mockBackend called twice");
			await page.unrouteAll();
			await installTrpcHandlers(page, overrides);
			installed = true;
		};
		await use(fn);
	},
	page: async ({ page }, use) => {
		await installTrpcHandlers(page);
		await use(page);
	},
});

export { expect };

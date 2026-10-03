import { test as base, expect } from "@playwright/test";
import {
	type HandlerOverrides,
	installTrpcHandlers,
	type TrpcCallLog,
} from "./handlers";

type Fixtures = {
	/** Replaces the default handlers; resolves to the per-procedure input log. */
	mockBackend: (overrides?: HandlerOverrides) => Promise<TrpcCallLog>;
};

export const test = base.extend<Fixtures>({
	mockBackend: async ({ page }, use) => {
		let installed = false;
		const fn = async (overrides: HandlerOverrides = {}) => {
			if (installed) throw new Error("mockBackend called twice");
			await page.unrouteAll();
			installed = true;
			return installTrpcHandlers(page, overrides);
		};
		await use(fn);
	},
	page: async ({ page }, use) => {
		await installTrpcHandlers(page);
		await use(page);
	},
});

export { expect };

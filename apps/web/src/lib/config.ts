// Client-side configuration
// Config is injected at runtime by serve.ts via window.__CONFIG__
// Falls back to defaults for development with Vite dev server

interface ClientConfig {
	apiUrl: string;
	/** MapLibre style JSON URL for the map view. */
	MAP_STYLE_URL: string;
}

declare global {
	interface Window {
		__CONFIG__?: Partial<ClientConfig>;
	}
}

const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const config: ClientConfig = {
	apiUrl:
		window.__CONFIG__?.apiUrl ||
		import.meta.env.VITE_API_URL ||
		"http://localhost:3000",
	MAP_STYLE_URL:
		window.__CONFIG__?.MAP_STYLE_URL ||
		import.meta.env.VITE_MAP_STYLE_URL ||
		DEFAULT_MAP_STYLE_URL,
};

export { config };

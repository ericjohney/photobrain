// Client-side configuration
// Config is injected at runtime by serve.ts via window.__CONFIG__
// Falls back to defaults for development with Vite dev server

interface ClientConfig {
	apiUrl: string;
}

declare global {
	interface Window {
		__CONFIG__?: ClientConfig;
	}
}

const config: ClientConfig = {
	apiUrl:
		window.__CONFIG__?.apiUrl ||
		import.meta.env.VITE_API_URL ||
		"http://localhost:3000",
};

export { config };

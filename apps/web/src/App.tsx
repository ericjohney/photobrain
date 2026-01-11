import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { About } from "@/pages/About";
import { Collections } from "@/pages/Collections";
import { Dashboard } from "@/pages/Dashboard";
import { Preferences } from "@/pages/Preferences";

function App() {
	// Initialize dark mode from localStorage or system preference
	useEffect(() => {
		const stored = localStorage.getItem("theme");
		const prefersDark = window.matchMedia(
			"(prefers-color-scheme: dark)",
		).matches;
		const shouldBeDark = stored === "dark" || (!stored && prefersDark);

		document.documentElement.classList.toggle("dark", shouldBeDark);
	}, []);

	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Dashboard />} />
				<Route path="/collections" element={<Collections />} />
				<Route path="/preferences" element={<Preferences />} />
				<Route path="/about" element={<About />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;

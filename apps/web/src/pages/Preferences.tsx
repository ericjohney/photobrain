import { Settings } from "lucide-react";
import { Layout } from "@/components/Layout";

export function Preferences() {
	return (
		<Layout title="Preferences">
			<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
				<Settings className="w-16 h-16 mb-4 opacity-20" />
				<h2 className="text-2xl font-semibold mb-2">Preferences</h2>
				<p className="text-sm">Customize your PhotoBrain experience</p>
				<p className="text-xs mt-4">Coming soon...</p>
			</div>
		</Layout>
	);
}

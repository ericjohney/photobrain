import { FolderOpen } from "lucide-react";
import { Layout } from "@/components/Layout";

export function Collections() {
	return (
		<Layout title="Collections">
			<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
				<FolderOpen className="w-16 h-16 mb-4 opacity-20" />
				<h2 className="text-2xl font-semibold mb-2">Collections</h2>
				<p className="text-sm">Organize your photos into collections</p>
				<p className="text-xs mt-4">Coming soon...</p>
			</div>
		</Layout>
	);
}

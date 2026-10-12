import { Settings } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Layout } from "@/components/Layout";

export function Preferences() {
	return (
		<Layout title="Preferences">
			<EmptyState
				icon={<Settings />}
				title="Customize your PhotoBrain experience"
				className="py-20"
			>
				Coming soon...
			</EmptyState>
		</Layout>
	);
}

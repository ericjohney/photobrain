import { Info } from "lucide-react";
import { Layout } from "@/components/Layout";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

export function About() {
	return (
		<Layout title="About">
			<div className="max-w-2xl mx-auto space-y-6">
				<div className="flex flex-col items-center text-center mb-8">
					<Info className="w-16 h-16 mb-4 text-primary" />
					<h2 className="text-3xl font-bold mb-2">PhotoBrain</h2>
					<p className="text-muted-foreground">
						A modern photo gallery application
					</p>
				</div>

				<Card>
					<CardHeader>
						<CardTitle>Version</CardTitle>
						<CardDescription>0.1.0</CardDescription>
					</CardHeader>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Technology Stack</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="space-y-2 text-sm text-muted-foreground">
							<li>• React 18 - UI framework</li>
							<li>• Vite - Build tool</li>
							<li>• TypeScript - Type safety</li>
							<li>• Tailwind CSS - Styling</li>
							<li>• shadcn/ui - UI components</li>
							<li>• React Router - Navigation</li>
							<li>• Hono API - Backend</li>
						</ul>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Features</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="space-y-2 text-sm text-muted-foreground">
							<li>• Browse photos in a responsive grid</li>
							<li>• Search photos by name</li>
							<li>• Fullscreen lightbox view</li>
							<li>• Fast photo scanning</li>
							<li>• Modern, clean interface</li>
						</ul>
					</CardContent>
				</Card>
			</div>
		</Layout>
	);
}

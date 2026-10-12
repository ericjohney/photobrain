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
					<img src="/favicon.svg" alt="" className="mb-4 h-16 w-16" />
					<h2 className="mb-1 text-2xl font-semibold tracking-tight">
						PhotoBrain
					</h2>
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
							<li>• Fast photo scanning</li>
							<li>• Modern, clean interface</li>
						</ul>
					</CardContent>
				</Card>
			</div>
		</Layout>
	);
}

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface LayoutProps {
	title?: string;
	actions?: ReactNode;
	children: ReactNode;
}

/** Simple page chrome for the secondary routes (About, Preferences). */
export function Layout({ title, actions, children }: LayoutProps) {
	return (
		<div className="flex min-h-screen flex-col bg-background">
			<header className="sticky top-0 z-40 border-b border-border bg-panel/90 backdrop-blur">
				<div className="flex h-12 items-center gap-3 px-4">
					<Link
						to="/"
						className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
					>
						<ArrowLeft className="h-4 w-4" />
						Library
					</Link>
					{title && <h1 className="text-sm font-semibold">{title}</h1>}
					{actions && (
						<div className="flex flex-1 items-center justify-end gap-2">
							{actions}
						</div>
					)}
				</div>
			</header>

			<main className="flex-1 p-6">{children}</main>
		</div>
	);
}

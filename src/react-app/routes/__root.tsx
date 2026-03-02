import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { MapPin, Github } from "lucide-react";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 mb-3 hover:opacity-80 transition-opacity">
            <MapPin className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">GNAF Lookup</h1>
          </Link>
          <p className="text-sm text-muted-foreground">
            Australian address lookup powered by the Geocoded National Address File
          </p>
          <a
            href="https://github.com/jxeeno/gnaf-serverless"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Github className="h-3.5 w-3.5" />
            View on GitHub
          </a>
        </div>
        <Outlet />
      </div>
    </div>
  );
}

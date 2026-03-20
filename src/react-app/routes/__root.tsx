import { useState, useEffect } from "react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { MapPin, Github } from "lucide-react";
import type { ShardMetadata } from "../../shared/types.js";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [metadata, setMetadata] = useState<ShardMetadata | null>(null);

  useEffect(() => {
    fetch("/api/metadata")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setMetadata(data); })
      .catch(() => {});
  }, []);

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
        {metadata && (
          <footer className="mt-12 pt-4 border-t border-border text-center text-[11px] text-muted-foreground space-y-1">
            <p>
              {metadata.gnafReleaseName ? `G-NAF ${metadata.gnafReleaseName}` : metadata.version}
              {" · "}
              {metadata.totalAddresses.toLocaleString()} addresses
              {" · "}
              {metadata.datum}
            </p>
            <p>
              Data: <a href="https://data.gov.au/dataset/geocoded-national-address-file-g-naf" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors underline underline-offset-2">data.gov.au</a>
              {" · "}
              Built {new Date(metadata.date).toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" })}
            </p>
          </footer>
        )}
      </div>
    </div>
  );
}

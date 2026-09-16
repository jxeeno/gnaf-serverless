import { useState, useEffect } from "react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import type { ShardMetadata } from "../../shared/types.js";
import { Container, Mark } from "../components/blade";

export const Route = createRootRoute({
  component: RootLayout,
});

const REPO = "https://github.com/jxeeno/gnaf-serverless";

function RootLayout() {
  const [metadata, setMetadata] = useState<ShardMetadata | null>(null);

  useEffect(() => {
    fetch("/api/metadata")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setMetadata(data);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-cream">
      <header className="bg-ink text-cream">
        <Container className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-[12.5px] font-semibold uppercase tracking-[0.1em]">
          <Link to="/" className="inline-flex items-center gap-2.5 text-cream no-underline">
            <Mark />
            <span className="font-extrabold tracking-[0.06em]">gnaf-serverless</span>
          </Link>
          <nav className="flex gap-4 sm:gap-5">
            <a href={`${REPO}#api`} className="text-[#d9d5c8] no-underline hover:text-white">
              API
            </a>
            <a href={`${REPO}#data-pipeline`} className="text-[#d9d5c8] no-underline hover:text-white">
              Pipeline
            </a>
            <a href={REPO} className="text-signal no-underline hover:text-white">
              GitHub ↗
            </a>
          </nav>
        </Container>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="bg-ink text-slate-text">
        <Container className="py-6">
          <div className="grid gap-4 text-[11.5px] leading-[1.65] md:grid-cols-[1.5fr_1fr] md:gap-8">
            <p className="m-0">
              Incorporates or developed using G-NAF © Geoscape Australia, licensed by the Commonwealth
              of Australia under the Geocoded National Address File (G-NAF) End User Licence
              Agreement.
              {metadata && (
                <>
                  {" "}
                  Release: {metadata.gnafReleaseName ?? metadata.version} · {metadata.datum} ·{" "}
                  {metadata.totalAddresses.toLocaleString()} addresses.
                </>
              )}{" "}
              Source:{" "}
              <a
                href="https://data.gov.au/dataset/geocoded-national-address-file-g-naf"
                className="text-signal no-underline hover:underline"
              >
                data.gov.au
              </a>
              .
            </p>
            <p className="m-0">
              Software © 2026 Jxeeno Pty Ltd, released under the MIT Licence. The MIT Licence covers
              this code only — G-NAF data remains subject to its own End User Licence Agreement.
            </p>
          </div>
        </Container>
      </footer>
    </div>
  );
}

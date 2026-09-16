import { useState, useEffect } from "react";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import type { ShardMetadata } from "../../shared/types.js";
import { Mark } from "../components/blade";

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
    <div className="min-h-screen bg-cream-deep">
      <div className="mx-auto w-full max-w-[940px] px-3 py-6 sm:px-5 sm:py-10">
        <div className="border border-hairline bg-cream shadow-[0_24px_60px_-30px_rgba(20,30,25,0.45)]">
          <header className="flex flex-wrap items-center justify-between gap-3 bg-ink px-4 py-3 text-[12.5px] font-semibold uppercase tracking-[0.1em] text-cream sm:px-6">
            <Link to="/" className="inline-flex items-center gap-2.5 text-cream no-underline">
              <Mark />
              <span className="font-extrabold tracking-[0.06em]">gnaf-serverless</span>
            </Link>
            <nav className="flex gap-4 text-[#d9d5c8] sm:gap-5">
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
          </header>

          <Outlet />

          <footer className="flex flex-col gap-3.5 bg-ink px-4 py-5 text-slate-text sm:px-6">
            <div className="h-px bg-slate-line" />
            <div className="grid gap-4 text-[11.5px] leading-[1.65] sm:grid-cols-[1.5fr_1fr] sm:gap-6">
              <p className="m-0">
                Incorporates or developed using G-NAF © Geoscape Australia, licensed by the
                Commonwealth of Australia under the Geocoded National Address File (G-NAF) End User
                Licence Agreement.
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
                Software © 2026 Kenneth Tsang, released under the MIT Licence. The MIT Licence covers
                this code only — G-NAF data remains subject to its own End User Licence Agreement.
              </p>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

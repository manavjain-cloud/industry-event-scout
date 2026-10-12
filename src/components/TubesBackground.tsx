"use client";

import { Shuffle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TubesApp } from "threejs-components/build/cursors/tubes1.min.js";
import { cn } from "@/lib/cn";

/**
 * Interactive neon-tube background (Three.js via the `threejs-components` tubes cursor).
 *
 * Adaptation notes (vs. dropping the reference snippet in as-is):
 *  - The module is imported dynamically inside an effect, so it is never evaluated on the
 *    server and never blocks first paint; a CSS gradient shows while it loads.
 *  - The library tracks the pointer on document.body and hit-tests against the canvas
 *    rectangle, so the canvas sits BEHIND the content with pointer-events:none and
 *    buttons, links and form controls stay fully interactive.
 *  - No "click anywhere to recolour": colours change only through the explicit button.
 *  - WebGL support is probed first; failure or reduced-motion falls back to the gradient.
 *  - dispose() runs on unmount (listeners + renderer), and a `cancelled` guard covers
 *    unmounting while the module is still loading. Resizing is handled by the library
 *    (size: "parent").
 *  - The package is installed from npm (pinned in package-lock), not loaded from a CDN, so
 *    there is no third-party network dependency at runtime.
 */

const PALETTES: Array<{ tubes: string[]; lights: string[] }> = [
  { tubes: ["#22e1ff", "#7c5cff", "#ff4fb0"], lights: ["#22e1ff", "#7c5cff", "#ff4fb0", "#a6ff62"] },
  { tubes: ["#5eead4", "#38bdf8", "#818cf8"], lights: ["#5eead4", "#38bdf8", "#818cf8", "#f0abfc"] },
  { tubes: ["#ff4fb0", "#ffc24a", "#9b7bff"], lights: ["#ff4fb0", "#ffc24a", "#9b7bff", "#22e1ff"] },
];

function webglAvailable(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function TubesBackground({
  className,
  showShuffle = true,
  variant = "hero",
}: {
  className?: string;
  showShuffle?: boolean;
  /** "hero": fades into the page at the bottom. "page": one fixed layer behind the whole site with an even scrim. */
  variant?: "hero" | "page";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<TubesApp | null>(null);
  const paletteIndex = useRef(0);
  const [status, setStatus] = useState<"loading" | "running">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Reduced motion, touch-only screens (no pointer to follow; saves battery) or no WebGL:
    // keep the static gradient (already fully visible); nothing to load.
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.matchMedia("(pointer: coarse)").matches ||
      !webglAvailable()
    ) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { default: createTubes } = await import("threejs-components/build/cursors/tubes1.min.js");
        if (cancelled) return;
        const palette = PALETTES[0];
        const app = createTubes(canvas, {
          bloom: { threshold: 0, strength: 0.9, radius: 0.4 }, // restrained glow (library default is 1.5)
          tubes: { colors: palette.tubes, lights: { intensity: 140, colors: palette.lights } },
        });
        if (cancelled) {
          app.dispose();
          return;
        }
        appRef.current = app;
        setStatus("running");
      } catch (err) {
        console.warn("3D background unavailable, using the static fallback.", err instanceof Error ? err.message : err);
      }
    })();

    return () => {
      cancelled = true;
      try {
        appRef.current?.dispose();
      } catch {
        /* renderer already gone */
      }
      appRef.current = null;
    };
  }, []);

  const shuffle = useCallback(() => {
    const app = appRef.current;
    if (!app) return;
    paletteIndex.current = (paletteIndex.current + 1) % PALETTES.length;
    const p = PALETTES[paletteIndex.current];
    app.tubes.setColors(p.tubes);
    app.tubes.setLightsColors(p.lights);
  }, []);

  return (
    <div className={cn(variant === "page" ? "pointer-events-none fixed inset-0 -z-10 overflow-hidden" : "absolute inset-0 overflow-hidden", className)}>
      <div aria-hidden="true" className={cn("hero-fallback absolute inset-0 transition-opacity duration-700", status === "running" ? "opacity-30" : "opacity-100")} />
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
      <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0", variant === "page" ? "bg-bg/45" : "scrim")} />
      {showShuffle && status === "running" && (
        <button
          type="button"
          onClick={shuffle}
          aria-label="Change background colours"
          title="Change background colours"
          className="pointer-events-auto fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface/70 px-3 py-1.5 text-xs text-muted backdrop-blur transition hover:text-ink"
        >
          <Shuffle className="size-3.5" aria-hidden="true" />
          Colours
        </button>
      )}
    </div>
  );
}

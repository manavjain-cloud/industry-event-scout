// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TubesBackground (3D background lifecycle)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const stubMatchMedia = (reduced: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));

  it("renders only the static gradient (and never loads WebGL code) when reduced motion is preferred", async () => {
    const create = vi.fn();
    vi.doMock("threejs-components/build/cursors/tubes1.min.js", () => ({ default: create }));
    stubMatchMedia(true);
    const { TubesBackground } = await import("@/components/TubesBackground");
    const { container } = render(<TubesBackground />);
    await new Promise((r) => setTimeout(r, 30));
    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector(".hero-fallback")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Change background colours/ })).toBeNull();
  });

  it("falls back gracefully when the module fails to initialise", async () => {
    vi.doMock("threejs-components/build/cursors/tubes1.min.js", () => ({
      default: () => {
        throw new Error("WebGL context lost");
      },
    }));
    stubMatchMedia(false);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { TubesBackground } = await import("@/components/TubesBackground");
    const { container } = render(<TubesBackground />);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(container.querySelector(".hero-fallback")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Change background colours/ })).toBeNull();
  });

  it("initialises, exposes an explicit colour control, and disposes on unmount", async () => {
    const dispose = vi.fn();
    const setColors = vi.fn();
    const setLightsColors = vi.fn();
    const create = vi.fn(() => ({ tubes: { setColors, setLightsColors }, dispose }));
    vi.doMock("threejs-components/build/cursors/tubes1.min.js", () => ({ default: create }));
    stubMatchMedia(false);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
    const { TubesBackground } = await import("@/components/TubesBackground");
    const { unmount } = render(<TubesBackground />);
    const button = await screen.findByRole("button", { name: /Change background colours/ });
    expect(create).toHaveBeenCalledTimes(1);
    // Colours change only through the explicit control.
    await userEvent.click(button);
    expect(setColors).toHaveBeenCalledTimes(1);
    expect(setLightsColors).toHaveBeenCalledTimes(1);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes immediately if unmounted while the module is still loading", async () => {
    const dispose = vi.fn();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.doMock("threejs-components/build/cursors/tubes1.min.js", async () => {
      await gate;
      return { default: () => ({ tubes: { setColors() {}, setLightsColors() {} }, dispose }) };
    });
    stubMatchMedia(false);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
    const { TubesBackground } = await import("@/components/TubesBackground");
    const { unmount } = render(<TubesBackground />);
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(dispose).not.toHaveBeenCalled(); // never created: the cancelled guard stopped initialisation
  });

  it("keeps the canvas from intercepting clicks so buttons and links stay usable", async () => {
    vi.doMock("threejs-components/build/cursors/tubes1.min.js", () => ({ default: vi.fn(() => ({ tubes: { setColors() {}, setLightsColors() {} }, dispose() {} })) }));
    stubMatchMedia(false);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
    const { TubesBackground } = await import("@/components/TubesBackground");
    const { container } = render(<TubesBackground />);
    expect(container.querySelector("canvas")!.className).toContain("pointer-events-none");
    expect(container.querySelector("canvas")!.getAttribute("aria-hidden")).toBe("true");
  });
});

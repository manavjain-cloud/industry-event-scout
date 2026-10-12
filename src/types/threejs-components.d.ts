/** Minimal typing for the pre-bundled tubes cursor module (the package ships no types). */
declare module "threejs-components/build/cursors/tubes1.min.js" {
  export interface TubesApp {
    tubes: {
      setColors(colors: string[]): void;
      setLightsColors(colors: string[]): void;
      setLightsIntensity?(value: number): void;
    };
    /** Removes the shared pointer listeners and releases the renderer / WebGL resources. */
    dispose(): void;
  }
  export interface TubesOptions {
    bloom?: { threshold: number; strength: number; radius: number };
    tubes?: {
      colors?: string[];
      lights?: { intensity?: number; colors?: string[] };
    };
    sleepRadiusX?: number;
    sleepRadiusY?: number;
    sleepTimeScale1?: number;
    sleepTimeScale2?: number;
  }
  const createTubes: (canvas: HTMLCanvasElement, options?: TubesOptions) => TubesApp;
  export default createTubes;
}

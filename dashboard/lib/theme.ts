// ===== theme
// The palette and light/dark mode are per-browser choices kept in localStorage, applied as
// data-palette and data-theme on <html> (app/globals.css). Per-user themes come with #37.

export const PALETTES = [
  // swatches: background, primary and secondary of the dark version
  { id: "paddock", name: "Paddock", swatch: ["#0b1018", "#45d6ae", "#61a5fa"] },
  { id: "classic", name: "Classic", swatch: ["#13110e", "#c8a04a", "#7fb069"] },
  { id: "phosphor", name: "Phosphor", swatch: ["#070b07", "#3be36b", "#ffb000"] },
  { id: "midnight", name: "Midnight", swatch: ["#000000", "#45d6ae", "#61a5fa"] },
] as const;
export type Palette = (typeof PALETTES)[number]["id"];
/** Palettes that have no light version and ignore the mode. */
export const DARK_ONLY: readonly Palette[] = ["midnight"];
export const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

const PALETTE_KEY = "paddock.palette";
const MODE_KEY = "paddock.mode";

/** Runs inline in <head> before the first paint, so a saved choice doesn't flash the default theme. */
const NON_DEFAULT = PALETTES.filter((p) => p.id !== "paddock").map((p) => `p==="${p.id}"`).join("||");
export const THEME_SCRIPT = `try{var d=document.documentElement,p=localStorage.getItem("${PALETTE_KEY}"),m=localStorage.getItem("${MODE_KEY}");if(${NON_DEFAULT})d.dataset.palette=p;if(m==="light"||m==="dark")d.dataset.theme=m}catch(e){}`;

export function currentTheme(): { palette: Palette; mode: Mode } {
  const d = document.documentElement.dataset;
  return {
    palette: PALETTES.find((p) => p.id === d.palette)?.id ?? "paddock",
    mode: d.theme === "light" || d.theme === "dark" ? d.theme : "system",
  };
}

/** The defaults remove the attribute and the stored value, so a later change of default reaches everyone who never picked. */
export function applyTheme(palette: Palette, mode: Mode) {
  const d = document.documentElement.dataset;
  if (palette === "paddock") delete d.palette;
  else d.palette = palette;
  if (mode === "system") delete d.theme;
  else d.theme = mode;
  // storage can be unavailable (private mode): the choice then lasts until the page reloads
  try {
    if (palette === "paddock") localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
    if (mode === "system") localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

export type VisualProfile = {
  name: "normal" | "conservative";
  font: string;
  columns: number;
  scale: number;
  fontSize: number;
  leading: number;
  sideMargin: number;
  gutter: number;
};

export const VISUAL_PROFILES: Record<VisualProfile["name"], VisualProfile> = {
  normal: { name: "normal", font: "Romulus", columns: 3, scale: 1, fontSize: 10.753, leading: 2.151, sideMargin: 12, gutter: 24 },
  conservative: { name: "conservative", font: "Romulus", columns: 3, scale: 1.05, fontSize: 10.753, leading: 2.151, sideMargin: 64, gutter: 32 },
};

export function getVisualProfile(name: string): VisualProfile {
  const profile = VISUAL_PROFILES[name as VisualProfile["name"]];
  if (!profile) throw new Error(`unknown visual profile "${name}"; available profiles: normal, conservative`);
  return profile;
}

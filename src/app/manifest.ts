import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "우리 가족 사진",
    short_name: "가족사진",
    start_url: "/",
    display: "standalone",
    background_color: "#fafaf9",
    theme_color: "#fff8f1",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}

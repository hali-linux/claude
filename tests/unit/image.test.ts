import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { processImage, sniffImageFormat } from "@/services/image";
import { AppError } from "@/lib/errors";

describe("이미지 형식 판별(매직 바이트)", () => {
  it("실제 이미지 형식을 판별한다", async () => {
    const make = (f: "jpeg" | "png" | "webp" | "gif" | "avif") =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: "#abc" } }).toFormat(f).toBuffer();
    expect(sniffImageFormat(await make("jpeg"))).toBe("jpeg");
    expect(sniffImageFormat(await make("png"))).toBe("png");
    expect(sniffImageFormat(await make("webp"))).toBe("webp");
    expect(sniffImageFormat(await make("gif"))).toBe("gif");
    expect(sniffImageFormat(await make("avif"))).toBe("avif");
  });

  it("이미지가 아닌 파일은 null", () => {
    expect(sniffImageFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImageFormat(Buffer.from("MZ\x90\x00 executable file here"))).toBeNull();
    expect(sniffImageFormat(Buffer.from("%PDF-1.7 ......"))).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(3))).toBeNull();
  });

  it("processImage는 비이미지를 415로 거부한다", async () => {
    await expect(processImage(Buffer.from("hello world, not an image"))).rejects.toMatchObject({ status: 415 });
    await expect(processImage(Buffer.from("hello world, not an image"))).rejects.toBeInstanceOf(AppError);
  });

  it("큰 이미지는 리사이즈된 썸네일/대형 이미지를 만든다", async () => {
    const buf = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#345" } }).jpeg().toBuffer();
    const out = await processImage(buf);
    const t = await sharp(out.thumb).metadata();
    const l = await sharp(out.large).metadata();
    expect(t.width).toBe(640);
    expect(l.width).toBe(2048);
    expect(out.width).toBe(4000);
  });
});

import "server-only";
import sharp, { type Metadata } from "sharp";
import exifr from "exifr";
import { unsupportedMedia } from "@/lib/errors";

/**
 * 이미지 처리 파이프라인.
 *
 *  1) 매직 바이트(파일 시그니처)로 실제 형식을 판별한다.
 *     - 확장자나 브라우저가 보낸 Content-Type은 쉽게 위조되므로 신뢰하지 않는다.
 *     - 이미지가 아닌 파일(HTML, SVG, 실행 파일 등)은 여기서 차단된다.
 *     - SVG는 스크립트를 포함할 수 있어 XSS 위험이 있으므로 허용하지 않는다.
 *  2) sharp로 실제 디코딩하여 손상/악성 파일을 걸러내고, 픽셀 수 제한으로 "이미지 폭탄"을 막는다.
 *  3) EXIF에서 촬영일시를 추출한다.
 *  4) EXIF Orientation에 맞게 회전한 뒤, 썸네일(640px)과 대형(2048px) WebP를 생성한다.
 *     파생 이미지에는 EXIF(GPS 위치 포함)가 남지 않는다(sharp 기본 동작).
 *     원본은 가족 기록 보존을 위해 그대로 보관하며, 원본 다운로드는 가족 구성원만 가능하다.
 */
export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif" | "heic";

export const FORMAT_INFO: Record<ImageFormat, { mime: string; ext: string }> = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  gif: { mime: "image/gif", ext: "gif" },
  webp: { mime: "image/webp", ext: "webp" },
  avif: { mime: "image/avif", ext: "avif" },
  heic: { mime: "image/heic", ext: "heic" },
};

export function sniffImageFormat(buf: Uint8Array): ImageFormat | null {
  if (buf.length < 12) return null;
  const ascii = (start: number, end: number) => String.fromCharCode(...buf.subarray(start, end));
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && ascii(1, 4) === "PNG" && buf[4] === 0x0d && buf[5] === 0x0a) return "png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

export const THUMB_SIZE = 640;
export const LARGE_SIZE = 2048;
/** 약 1억 픽셀(예: 10000x10000) 초과 이미지는 거부 → 메모리 고갈(Decompression bomb) 방지 */
const MAX_INPUT_PIXELS = 100_000_000;

export interface ProcessedImage {
  format: ImageFormat;
  mime: string;
  ext: string;
  width: number;
  height: number;
  takenAt: Date | null;
  thumb: Buffer;
  large: Buffer;
}

// sharp는 CPU를 많이 사용하므로 동시에 처리하는 이미지 수를 제한한다.
// (여러 사용자가 동시에 수십 장씩 올려도 서버가 멈추지 않도록)
const MAX_CONCURRENT = Math.max(1, Number(process.env.IMAGE_CONCURRENCY) || 2);
let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

sharp.cache(false); // 요청마다 다른 이미지를 처리하므로 libvips 캐시는 메모리만 차지한다.

async function extractTakenAt(buf: Buffer): Promise<Date | null> {
  try {
    const exif = await exifr.parse(buf, { pick: ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"] });
    const d: unknown = exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.DateTimeDigitized;
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      if (y >= 1900 && d.getTime() <= Date.now() + 86_400_000) return d;
    }
  } catch {
    // EXIF가 없거나 손상된 경우 무시 (촬영일시는 선택 정보)
  }
  return null;
}

export async function processImage(buf: Buffer): Promise<ProcessedImage> {
  const format = sniffImageFormat(buf);
  if (!format) throw unsupportedMedia("지원하지 않는 파일 형식입니다. JPG, PNG, WEBP, GIF, AVIF, HEIC 사진만 올릴 수 있습니다.");

  return withSlot(async () => {
    const base = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
    let meta: Metadata;
    try {
      meta = await base().metadata();
    } catch {
      if (format === "heic") {
        throw unsupportedMedia("이 HEIC 사진은 처리할 수 없습니다. 아이폰 설정 > 카메라 > 포맷에서 '높은 호환성'을 선택하거나 JPG로 변환해 올려주세요.");
      }
      throw unsupportedMedia("손상되었거나 올바르지 않은 이미지 파일입니다.");
    }
    if (!meta.width || !meta.height) throw unsupportedMedia("이미지 크기를 확인할 수 없습니다.");

    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;

    try {
      const [thumb, large, takenAt] = await Promise.all([
        base()
          .rotate()
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 74, effort: 4 })
          .toBuffer(),
        base()
          .rotate()
          .resize(LARGE_SIZE, LARGE_SIZE, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 84, effort: 4 })
          .toBuffer(),
        extractTakenAt(buf),
      ]);
      return { format, ...FORMAT_INFO[format], width, height, takenAt, thumb, large };
    } catch {
      throw unsupportedMedia("이미지를 처리하지 못했습니다. 다른 사진으로 시도해주세요.");
    }
  });
}

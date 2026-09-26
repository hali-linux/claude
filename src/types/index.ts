/** 클라이언트/서버가 공유하는 API 응답 타입 */

export interface PhotoDTO {
  id: string;
  familyId: string;
  originalName: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  takenAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  uploader: { id: string; name: string } | null;
  album: { id: string; name: string } | null;
  thumbUrl: string;
  largeUrl: string;
  downloadUrl: string;
  isFavorite: boolean;
  /** 현재 사용자가 수정/삭제 가능한지 */
  canModify: boolean;
}

export interface AlbumDTO {
  id: string;
  familyId: string;
  name: string;
  description: string | null;
  photoCount: number;
  coverUrl: string | null;
  coverPhotoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhotoPage {
  items: PhotoDTO[];
  nextCursor: string | null;
}

export type FamilyRoleName = "ADMIN" | "MEMBER";

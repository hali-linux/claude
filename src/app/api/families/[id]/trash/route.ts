import { requireFamilyAdmin } from "@/lib/access";
import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { listTrash, purgeTrash } from "@/services/photo-service";

type Ctx = { params: Promise<{ id: string }> };

/** 휴지통 목록 (가족 관리자) */
export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  return json({ items: await listTrash(user, id) });
});

/** 휴지통 비우기: 휴지통의 모든 사진을 영구 삭제 */
export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await requireFamilyAdmin(user, id);
  const deleted = await purgeTrash({ familyId: id, olderThanDays: 0 });
  return json({ deleted });
});

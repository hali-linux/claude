# 📸 우리 가족 사진

가족 구성원끼리만 안전하게 사진을 올리고, 앨범으로 정리하고, 함께 보는 웹 서비스입니다.
스마트폰에서 쓰기 편한 **모바일 우선 반응형 UI**와, 가족사진이라는 사적인 자료를 지키기 위한 **보안**을 가장 중요하게 설계했습니다.

| 우선순위 | 설계 포인트 |
| --- | --- |
| 1. 사진 보안 | 모든 이미지 요청마다 로그인 + 가족 구성원 여부 검사, Private 저장소 + 만료되는 URL, IDOR 방지, 매직 바이트 검증 |
| 2. 업로드 안정성 | 사진별 개별 요청, 3장 동시 병렬, 자동 재시도(지수 백오프), 실패한 사진만 재업로드, 중복 업로드 멱등 처리 |
| 3. 모바일 사용성 | 하단 탭 내비게이션, 카메라 촬영 업로드, 스와이프 넘기기, 뒤로가기로 사진 닫기, Safe Area 대응 |
| 4. 갤러리 성능 | 640px WebP 썸네일 / 2048px 대형 이미지 분리, lazy loading, 커서 기반 무한 스크롤, 스트리밍 ZIP |
| 5. 유지보수성 | 서비스 계층 분리, 저장소 추상화(Local ↔ S3), zod 검증, 통합 테스트 |

---

## 1. 주요 기능

- **회원가입 / 로그인 / 로그아웃 / 비밀번호 변경** (DB 세션, HttpOnly 쿠키, 30일 자동 연장)
- **가족 그룹**: 한 사용자가 여러 가족(예: 친가, 외가)에 참여, 화면 상단에서 전환
- **초대**: 관리자가 이메일로 초대 링크 생성 (72시간 만료 · 1회용 · 초대받은 이메일만 가입 가능)
- **앨범**: 생성 / 수정 / 삭제(사진 유지 또는 휴지통 이동 선택) / 대표사진 지정 / 앨범별 조회
- **사진 업로드**: 여러 장 선택, Drag & Drop, 스마트폰 카메라 촬영, 파일별 진행률, 실패 재시도
- **이미지 처리**: 매직 바이트 검증, EXIF 촬영일 추출, 자동 회전, 썸네일·대형 WebP 생성, 파생 이미지 위치정보(GPS) 제거
- **갤러리**: 반응형 그리드(모바일 3열 ~ PC 6열), 무한 스크롤
- **Lightbox**: 이전/다음(← →, 스와이프), 확대(더블탭/버튼 + 드래그 이동), ESC·아래 스와이프·뒤로가기로 닫기, 다운로드, 삭제, 정보/설명 수정, 앨범 이동
- **검색**: 설명 · 파일명 · 앨범명 · 올린 사람 / 촬영일·업로드일 기준 오늘 · 7일 · 30일 · 올해 · 직접 지정
- **즐겨찾기** ⭐ (사용자별)
- **다운로드**: 개별 원본 다운로드, 앨범 전체 ZIP(스트리밍, 300장 단위 분할)
- **삭제**: 확인창 → 휴지통(Soft Delete) → 관리자가 복구/영구 삭제, 보관기간 경과 시 자동 정리 스크립트
- **관리자 페이지**: 사진 수 · 저장공간 · 구성원 · 앨범 통계, 사용자별 업로드 현황, 구성원 역할 변경/제거, 초대 관리, 휴지통
- **홈**: 최근 사진, 최근 앨범, 즐겨찾기, 가족 구성원, 최근 활동(“엄마님이 명절에 사진 12장을 올렸어요”)

### 권한 정책

| 작업 | 가족 관리자(ADMIN) | 구성원(MEMBER) |
| --- | --- | --- |
| 사진 보기 / 업로드 / 즐겨찾기 / 다운로드 | ✅ | ✅ |
| 사진 설명 수정 · 앨범 이동 · 삭제 | 모든 사진 | 자신이 올린 사진만 |
| 앨범 생성 · 수정 · 삭제 · 대표사진 | ✅ | ❌ |
| 구성원 초대 · 제거 · 역할 변경 | ✅ | ❌ (스스로 나가기만 가능) |
| 휴지통 복구 · 영구 삭제 · 관리자 페이지 | ✅ | ❌ |

`User.role`(ADMIN/MEMBER)은 서비스 전체 역할(최초 가입자 = ADMIN)이고, 사진 권한은 가족 단위 역할인 `FamilyMember.role`로 판단합니다. 가족마다 관리자가 다를 수 있기 때문입니다.

---

## 2. 기술 스택

| 영역 | 기술 |
| --- | --- |
| Frontend | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 4 |
| Backend | Next.js Route Handlers (REST API), Proxy(구 Middleware) |
| Database | PostgreSQL 16, Prisma 7 (`@prisma/adapter-pg`) |
| 이미지 | sharp (리사이즈/WebP), exifr (EXIF) |
| 저장소 | Local 디스크 / AWS S3 (+ 선택: CloudFront Signed URL) |
| 인증 | 자체 구현 DB 세션 + bcrypt(cost 12) |
| 검증 | zod |
| 테스트 | Vitest (실제 PostgreSQL을 사용하는 통합 테스트) |
| 배포 | Docker (standalone 빌드), docker compose |

---

## 3. 프로젝트 구조

```
.
├── prisma/
│   ├── schema.prisma          # DB 스키마 (User, Session, Family, FamilyMember, Album, Photo, Favorite, Invitation, Activity)
│   ├── migrations/            # 마이그레이션 SQL
│   └── seed.ts                # 개발용 샘플 데이터
├── prisma.config.ts           # Prisma 7 설정
├── scripts/purge-trash.ts     # 휴지통 자동 정리 (cron)
├── src/
│   ├── proxy.ts               # CSP(nonce), HSTS, 비로그인 사용자 리다이렉트
│   ├── app/
│   │   ├── (auth)/            # 로그인, 회원가입
│   │   ├── invite/[token]/    # 초대 수락
│   │   ├── (app)/             # 로그인 사용자 영역: 홈, 사진, 앨범, 즐겨찾기, 가족, 설정, 업로드, 관리자
│   │   └── api/               # REST API (아래 표 참고)
│   ├── components/            # UI 컴포넌트 (gallery, lightbox, uploader, admin/*, ...)
│   ├── services/              # 비즈니스 로직 (photo, album, family, invitation, auth, zip, admin, image)
│   │   └── storage/           # StorageService 인터페이스 + LocalStorageService + S3StorageService
│   ├── lib/                   # env, db, session, access(권한), http(API 래퍼·CSRF), rate-limit, validation, logger
│   ├── types/                 # API 응답 타입(DTO)
│   └── generated/prisma/      # Prisma Client (자동 생성, Git 제외)
├── tests/
│   ├── integration/           # auth, permissions, photos, albums, invitations
│   └── unit/                  # 이미지 판별, 입력 검증, 보안 유틸
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

**계층 구조**: `app/api/*/route.ts`(HTTP 입출력·검증) → `services/*`(비즈니스 로직·권한 검사) → `lib/db`(Prisma) / `services/storage`(파일).
페이지(Server Component)는 서비스를 직접 호출해 첫 화면을 빠르게 그리고, 변경 작업은 클라이언트에서 REST API를 호출합니다.

### API

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/auth/register` | 회원가입 (초대 토큰 선택) |
| POST | `/api/auth/login` · `/api/auth/logout` | 로그인 · 로그아웃 |
| GET | `/api/auth/me` | 내 정보 |
| PUT | `/api/auth/password` | 비밀번호 변경 (다른 기기 세션 폐기) |
| PATCH | `/api/auth/profile` | 이름 변경 |
| GET · POST | `/api/families` | 내 가족 목록 · 새 가족 |
| PATCH | `/api/families/:id` | 가족 정보 수정 (관리자) |
| POST | `/api/families/current` | 현재 가족 전환 |
| GET | `/api/families/:id/members` | 구성원 목록 |
| PATCH · DELETE | `/api/families/:id/members/:userId` | 역할 변경 · 제거(또는 나가기) |
| GET | `/api/families/:id/stats` | 관리자 통계 |
| GET · DELETE | `/api/families/:id/trash` | 휴지통 목록 · 비우기 |
| GET · POST | `/api/albums` | 앨범 목록 · 생성 |
| GET · PUT · DELETE | `/api/albums/:id` | 앨범 조회 · 수정(대표사진 포함) · 삭제(`?deletePhotos=1`) |
| GET | `/api/albums/:id/download?part=N` | 앨범 ZIP 스트리밍 다운로드 |
| GET | `/api/photos` | 사진 목록/검색 (`q, albumId, uploaderId, favorites, dateField, preset, from, to, cursor, limit`) |
| POST | `/api/photos/upload` | 사진 업로드 (multipart, 1장) |
| GET · PATCH · DELETE | `/api/photos/:id` | 조회 · 설명/앨범/촬영일 수정 · 휴지통 이동(`?permanent=1` 영구 삭제) |
| POST | `/api/photos/:id/restore` | 휴지통에서 복구 |
| POST · DELETE | `/api/photos/:id/favorite` | 즐겨찾기 추가 · 해제 |
| GET | `/api/photos/:id/image?v=thumb\|large\|original[&download=1]` | 인증된 이미지 제공 |
| GET · POST | `/api/invitations` | 초대 목록 · 생성 |
| DELETE | `/api/invitations/:id` | 초대 취소 |
| POST | `/api/invitations/accept` | 초대 수락 (로그인 사용자) |
| GET | `/api/health` | 헬스체크 |

---

## 4. 설치 방법

필수: **Node.js 20.19+ (22 권장)**, **PostgreSQL 14+** (또는 Docker)

```bash
git clone <이 저장소>
cd <저장소>
npm install          # postinstall에서 Prisma Client가 자동 생성됩니다
cp .env.example .env
```

## 5. 환경변수 설정

`.env`에서 최소한 아래 3개를 설정합니다. 전체 목록과 설명은 [`.env.example`](.env.example)에 있습니다.

```bash
DATABASE_URL="postgresql://family:family@localhost:5432/family_photos?schema=public"
AUTH_SECRET="$(openssl rand -base64 48)"   # 32자 이상 무작위 값
APP_URL="http://localhost:3000"
```

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | – | PostgreSQL 연결 문자열 |
| `AUTH_SECRET` | – | 세션/초대 토큰 HMAC 키 (운영에서 기본값 사용 시 서버가 시작되지 않음) |
| `APP_URL` | `http://localhost:3000` | 초대 링크 주소, CSRF 검사, `https://`면 Secure 쿠키·HSTS 자동 적용 |
| `ALLOW_OPEN_REGISTRATION` | `false` | `false`: 최초 1명 + 초대받은 사람만 가입 |
| `STORAGE_DRIVER` | `local` | `local` 또는 `s3` |
| `STORAGE_LOCAL_DIR` | `./storage` | 로컬 저장 경로 (public 폴더 밖) |
| `MAX_UPLOAD_MB` | `30` | 사진 1장 최대 크기 |
| `MAX_ZIP_PHOTOS` | `300` | ZIP 파일 1개당 최대 사진 수 |
| `TRASH_RETENTION_DAYS` | `30` | 휴지통 보관 기간 |
| `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | – | S3 사용 시 |
| `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY` | – | CloudFront Signed URL 사용 시 |
| `SMTP_URL`, `MAIL_FROM` | – | 초대 메일 발송 (없으면 링크 복사로 전달) |
| `TRUST_PROXY` | `false` | 리버스 프록시 뒤에서 `X-Forwarded-*` 신뢰 |
| `TZ`, `NEXT_PUBLIC_TIMEZONE` | `Asia/Seoul` | 날짜 검색·표시 기준 시간대 |

## 6. 데이터베이스 생성

Docker로 PostgreSQL만 띄우는 것이 가장 간단합니다.

```bash
docker compose up -d db
```

직접 설치한 PostgreSQL을 쓴다면:

```sql
CREATE USER family WITH PASSWORD 'family' CREATEDB;
CREATE DATABASE family_photos OWNER family;
CREATE DATABASE family_photos_test OWNER family;  -- 테스트용
```

## 7. Prisma migration

```bash
npm run db:migrate     # 개발: 마이그레이션 적용 (스키마 변경 시 새 마이그레이션 생성)
npm run db:deploy      # 운영: 기존 마이그레이션만 적용
npm run db:seed        # (선택) 샘플 계정/앨범 생성: dad@example.com / password123
npm run db:studio      # (선택) DB GUI
```

## 8. 개발 서버 실행

```bash
npm run dev
```

http://localhost:3000 → **회원가입**. 첫 번째 가입자가 서비스 관리자이자 첫 가족의 관리자가 됩니다.
이후 가족은 **관리자 페이지 → 가족 구성원 초대**에서 만든 링크로 가입합니다.

> 스마트폰에서 테스트하려면 `npm run dev -- -H 0.0.0.0` 후 `APP_URL`을 PC의 IP 주소(예: `http://192.168.0.10:3000`)로 바꿔주세요.

## 9. 테스트 실행

테스트는 **실제 PostgreSQL 테스트 DB**(`family_photos_test`)에 대해 실행되며, 실행할 때마다 스키마를 초기화합니다. 개발 DB는 건드리지 않습니다.

```bash
npm test                  # 전체 테스트
npm run typecheck         # TypeScript 검사
npm run lint              # ESLint
npm run check             # 타입 + 린트 + 테스트 + 빌드 한 번에
```

테스트 DB 주소를 바꾸려면 `TEST_DATABASE_URL`을 지정합니다.

| 영역 | 테스트 내용 |
| --- | --- |
| 인증 | 회원가입, 로그인, 로그아웃(세션 폐기), 잘못된 비밀번호, 계정 열거 방지, 로그인 Rate Limit, 미인증 접근 차단, CSRF(Origin) 차단, 비밀번호 변경 |
| 권한 | 다른 가족 사진/이미지/앨범/ZIP/구성원 접근 차단(IDOR), familyId 조작 차단, MEMBER의 관리자 기능 차단, 다른 사용자 사진 삭제 차단, 마지막 관리자 보호 |
| 사진 | 정상 업로드, 여러 장 동시 업로드, 중복 업로드 멱등성, 너무 큰 파일, 허용되지 않은 형식(HTML/위장 JPG/SVG/손상 파일), EXIF·회전·GPS 제거, 검색·필터·페이지네이션, 즐겨찾기, 휴지통·복구·영구 삭제, 원본 다운로드 |
| 앨범 | 생성, 수정, 삭제(옵션별), 사진 추가/이동, 다른 가족 앨범으로 이동 차단, 대표사진, ZIP 분할 다운로드 |
| 초대 | 초대 가입, 1회용, 만료, 취소, 이메일 불일치 차단, 기존 사용자 수락 |

## 10. Docker 실행 방법

```bash
cp .env.example .env
# .env에서 AUTH_SECRET을 설정 (openssl rand -base64 48)
docker compose up -d
```

- `db`(PostgreSQL) → `migrate`(마이그레이션 1회 실행 후 종료) → `app`(Next.js) 순서로 시작합니다.
- 사진은 `photos` 볼륨, DB는 `pgdata` 볼륨에 보관됩니다. **두 볼륨을 함께 백업하세요.**
- 로그 확인: `docker compose logs -f app`
- 업데이트: `git pull && docker compose up -d --build`
- 휴지통 정리(선택, 하루 1회 cron): `docker compose run --rm migrate npm run purge-trash`

## 11. AWS S3 설정 방법

1. **버킷 생성** (예: `my-family-photos`, 리전 `ap-northeast-2`)
   - **Block all public access: ON** (절대 끄지 마세요)
   - Object Ownership: *Bucket owner enforced* (ACL 비활성화)
   - Default encryption: SSE-S3
   - (권장) Versioning ON — 실수로 지운 파일 복구용
2. **IAM 정책** — 이 버킷에만 최소 권한 부여

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::my-family-photos/*"
     }]
   }
   ```

   EC2/ECS에서는 이 정책을 **IAM Role**에 연결하고 액세스 키는 비워두는 것을 권장합니다.
3. **CORS 설정은 필요 없습니다.** 업로드는 서버를 거쳐(검증·썸네일 생성) S3에 저장되고, 브라우저는 `<img>`로 Presigned URL을 읽기만 합니다.
4. `.env` 설정

   ```bash
   STORAGE_DRIVER=s3
   S3_BUCKET=my-family-photos
   AWS_REGION=ap-northeast-2
   S3_PRESIGN_EXPIRES_SECONDS=900
   ```

5. **(선택) CloudFront**
   - 원본: S3 버킷, **Origin Access Control(OAC)** 사용 → 버킷 정책에서 CloudFront만 읽기 허용
   - *Restrict viewer access* 켜고 Trusted key group에 공개키 등록
   - `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY` 설정 → 앱이 자동으로 CloudFront Signed URL을 발급합니다.

**동작 방식**: 사진 목록 API가 호출될 때 서버가 로그인·가족 권한을 확인한 뒤 15분짜리 서명 URL을 만들어 응답합니다. 권한이 없는 사람은 URL을 얻을 수 없고, 유출된 URL도 곧 만료됩니다. 로컬 저장소에서는 `/api/photos/:id/image`가 매 요청 권한을 검사한 뒤 파일을 스트리밍합니다.

기존 로컬 사진을 S3로 옮길 때는 저장 키 구조가 같으므로 `aws s3 sync ./storage s3://my-family-photos` 후 `STORAGE_DRIVER=s3`로 바꾸면 됩니다.

## 12. 운영환경 배포 방법

```
사용자 ──HTTPS──▶ ALB/Nginx ──▶ Next.js (Docker) ──▶ PostgreSQL (RDS)
                                    │
                                    └─▶ S3 (Private) ◀── CloudFront (OAC, Signed URL) ◀── 사용자 브라우저
```

1. **HTTPS 필수**: ALB + ACM 인증서, 또는 Nginx/Caddy + Let's Encrypt. `APP_URL=https://photos.example.com`
   → Secure `__Host-` 쿠키, HSTS, `upgrade-insecure-requests`가 자동 적용됩니다.
2. 리버스 프록시 뒤라면 `TRUST_PROXY=true` (Rate Limit가 실제 클라이언트 IP 기준으로 동작)
3. Nginx를 쓴다면 업로드 크기 허용: `client_max_body_size 35m;`
4. DB: RDS PostgreSQL + 자동 백업. 배포 시 `npm run db:deploy`(또는 compose의 `migrate`) 실행
5. 이미지: `docker build --target runner -t family-photos .` 후 ECS/EC2/Lightsail 등에서 실행
6. cron으로 `npm run purge-trash` 하루 1회 실행
7. 서버를 2대 이상으로 늘릴 경우: 반드시 `STORAGE_DRIVER=s3`, Rate Limiter를 Redis 기반으로 교체(`src/lib/rate-limit.ts`의 `RateLimitStore`)

---

## 보안 설계 요약

| 위협 | 대응 |
| --- | --- |
| URL만 알면 사진을 볼 수 있음 | 사진은 public 폴더 밖/Private 버킷에 저장. 이미지 API가 매 요청 세션+가족 멤버십 검사, S3는 15분 만료 Presigned URL |
| IDOR (다른 가족 리소스 id 대입) | 모든 리소스를 id로 조회한 뒤 **DB에 저장된 familyId**로 멤버십 검사, 비구성원에게는 404 (`src/lib/access.ts`) |
| CSRF | SameSite=Lax 쿠키 + 상태 변경 요청의 `Origin`/`Sec-Fetch-Site` 검사 (`src/lib/http.ts`) |
| XSS | React 자동 이스케이프, nonce 기반 CSP, SVG 업로드 금지, 이미지 응답에 `nosniff` + `sandbox` CSP |
| SQL Injection | Prisma 파라미터 바인딩만 사용 (raw query는 태그드 템플릿만) |
| 악성 파일 업로드 | 확장자·MIME 허용 목록 + **매직 바이트 검사** + sharp 실제 디코딩, 픽셀 수 제한(이미지 폭탄), 저장 키는 UUID(파일명 미사용), 경로 조작 검사 |
| 대용량 요청 | Content-Length 사전 차단, 파일 크기 제한, 이미지 처리 동시성 제한, ZIP 분할 + 사용자당 1개 |
| 무차별 대입 | 로그인 IP·계정별 Rate Limit, 업로드·초대·ZIP Rate Limit |
| 세션 탈취 | HttpOnly · Secure · `__Host-` 쿠키, DB에는 토큰 HMAC만 저장, 로그아웃/비밀번호 변경 시 즉시 폐기 |
| 비밀번호 유출 | bcrypt(cost 12), 계정 열거 방지(동일 메시지 + 더미 해시 비교) |
| 초대 링크 악용 | 256bit 토큰, 해시 저장, 만료, 원자적 1회 사용, 초대 이메일과 일치해야 수락, Referrer 차단 |
| 정보 노출 | 사용자에게는 친절한 한국어 메시지만, 서버 로그에는 상세 오류 + errorId, 로그에서 password/token/cookie 자동 마스킹 |
| Open Redirect | 로그인 후 이동 경로는 같은 사이트 상대경로만 허용 |
| 위치정보 노출 | 썸네일·대형 이미지에서 EXIF(GPS 포함) 제거. 원본은 기록 보존을 위해 그대로 두며 가족 구성원만 다운로드 가능 |
| 검색엔진 노출 | `robots: noindex, nofollow` |

## 중요한 기술적 선택

- **JWT 대신 DB 세션**: 로그아웃·비밀번호 변경·구성원 제거 시 즉시 접근을 끊을 수 있어야 하기 때문입니다.
- **업로드는 서버 경유**: S3 직접 업로드(Presigned PUT)는 서버 부하가 적지만, 업로드 전에 파일 내용을 검증하고 썸네일을 만들 수 없습니다. 보안이 1순위이므로 서버에서 검증 후 저장합니다. 규모가 커지면 "S3 직접 업로드 → Lambda 검증·썸네일" 구조로 확장할 수 있습니다.
- **사진 1장 = 요청 1개**: 파일별 진행률·재시도가 정확하고, 실패가 다른 사진에 영향을 주지 않습니다. 동일 파일(SHA-256)은 다시 저장하지 않으므로 재시도가 안전합니다.
- **`next/image` 미사용**: 이미지 최적화 서버가 사용자 쿠키 없이 이미지를 가져오게 되어 인증 구조와 맞지 않습니다. 대신 업로드 시점에 썸네일을 미리 만들어 둡니다.
- **Proxy는 `/api`를 제외**: Proxy를 거치면 요청 본문이 메모리에 버퍼링되어 업로드에 불리합니다. API는 각자 인증을 검사합니다.

## 알려진 제한 / 참고

- HEIC: 서버의 sharp(libvips) 빌드에 따라 HEVC 디코딩이 지원되지 않을 수 있습니다. 아이폰 Safari는 사진 선택 시 보통 JPEG로 변환해 올리며, 실패하면 사용자에게 변환 방법을 안내합니다.
- `npm audit`에 표시되는 `mysql2` 경고는 Prisma CLI(개발 도구)의 의존성이며 실행 중인 서버에는 포함되지 않습니다.
- Rate Limiter는 인메모리 방식이라 서버 1대 기준입니다.

## 향후 추가하면 좋은 기능

- 동영상 업로드(HLS 변환), Live Photo
- S3 직접 업로드 + Lambda 썸네일 (대규모 트래픽)
- 대용량 앨범 ZIP 백그라운드 생성 후 이메일로 링크 전달
- 여러 장 선택 후 일괄 이동/삭제/다운로드
- 얼굴 인식으로 인물별 앨범, 지도 보기(GPS 동의 시)
- 사진 댓글 · 좋아요 · 새 사진 알림(웹 푸시)
- 2단계 인증(TOTP), 비밀번호 재설정 메일
- PWA 오프라인 캐시, 공유 시트에서 바로 업로드(Web Share Target)
- pg_trgm 인덱스로 대규모 검색 성능 향상
- Redis 기반 Rate Limit / 세션 캐시

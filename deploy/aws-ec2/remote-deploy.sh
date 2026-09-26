#!/bin/bash
# EC2 인스턴스에서 실행 (deploy.sh가 SSM Run Command로 호출)
#   remote-deploy.sh <s3 소스 tar.gz URI> <APP_URL>
set -euo pipefail
SRC_URI="$1"
APP_URL="$2"
REGION=ap-northeast-2
BASE=/opt/family-photos
APP="$BASE/app"

# user-data 부트스트랩(docker 설치 등) 완료 대기
for _ in $(seq 1 60); do [ -f "$BASE/.bootstrap-done" ] && break; sleep 5; done
[ -f "$BASE/.bootstrap-done" ] || { echo "bootstrap not finished"; exit 1; }

param() { aws ssm get-parameter --region "$REGION" --with-decryption --name "/family-photos/$1" --query Parameter.Value --output text; }

rm -rf "$APP.new" && mkdir -p "$APP.new"
aws s3 cp --region "$REGION" "$SRC_URI" - | tar -xz -C "$APP.new"
cp "$APP.new/deploy/aws-ec2/docker-compose.aws.yml" "$APP.new/docker-compose.aws.yml"

umask 077
cat > "$APP.new/.env" <<ENV
AUTH_SECRET=$(param AUTH_SECRET)
POSTGRES_PASSWORD=$(param POSTGRES_PASSWORD)
APP_URL=$APP_URL
ALLOW_OPEN_REGISTRATION=false
TZ=Asia/Seoul
NEXT_PUBLIC_TIMEZONE=Asia/Seoul
TRUST_PROXY=false
STORAGE_DRIVER=local
IMAGE_CONCURRENCY=1
ENV

rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
cd "$APP"
# 프로젝트 이름을 고정해 디렉터리가 바뀌어도 같은 볼륨(pgdata, photos)을 사용
export COMPOSE_PROJECT_NAME=family-photos
docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d --build --remove-orphans
docker image prune -f >/dev/null

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1/api/health && { echo; echo "deploy OK"; exit 0; }
  sleep 5
done
docker compose -f docker-compose.yml -f docker-compose.aws.yml logs --tail 100 app
exit 1

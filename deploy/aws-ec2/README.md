# AWS EC2 단일 서버 + ALB(HTTPS) 배포

```
사용자 ──HTTPS(443)──▶ ALB (ACM *.netdoctor.shop) ──HTTP(80)──▶ EC2 (docker compose: 앱 + PostgreSQL)
        ──HTTP(80)───▶ ALB ──301──▶ HTTPS
```

EC2 1대(t3.small, 서울 리전)에서 `docker compose`로 앱과 PostgreSQL을 실행합니다. 사진은 로컬 디스크(Docker 볼륨)에 저장됩니다.
EC2는 ALB 보안 그룹에서 오는 트래픽만 받으므로 인스턴스 IP로 직접 접속할 수 없습니다.

| 리소스 | 값 |
| --- | --- |
| 주소 | https://photos.netdoctor.shop (Route 53 Alias → ALB) |
| ACM 인증서 | `*.netdoctor.shop` (`certificate/b81f17e1-0a27-4ad2-969a-2edcac8f7cb7`, DNS 검증, 자동 갱신) |
| ALB | `family-photos-alb`: 443(TLS 1.2/1.3) → 대상 그룹 `family-photos-tg`(EC2:80, `/api/health`), 80 → HTTPS 301, idle timeout 300초 |
| ALB 보안 그룹 | `sg-0c0e7277b9c1428b2`: 80, 443 전체 허용 |
| EC2 | `i-01bccdf9f7e5575d0`, Elastic IP 15.164.201.49는 외부 통신(빌드)용 (Amazon Linux 2023, t3.small, 30GB gp3 암호화, 2GB swap) |
| EC2 보안 그룹 | `sg-03677a3a4ddb57b0e`: ALB 보안 그룹에서 오는 80만 허용 (SSH 없음, 접속은 SSM Session Manager) |
| IAM 역할 | `family-photos-ec2`: SSM, 배포 버킷 읽기, `/family-photos/*` 파라미터 읽기 |
| 비밀값 | SSM Parameter Store `/family-photos/AUTH_SECRET`, `/family-photos/POSTGRES_PASSWORD` |
| 배포 버킷 | `s3://family-photos-deploy-137181255849` (소스 tar.gz) |
| 백업 | DLM 정책 `policy-06112ddfe18cb057f`: 매일 03:00 KST EBS 스냅샷, 7개 보관 |
| 휴지통 정리 | 인스턴스의 systemd 타이머 `family-photos-purge.timer` (매일 04:00) |

## 재배포

```bash
deploy/aws-ec2/deploy.sh    # 현재 커밋(HEAD)을 업로드하고, EC2에서 빌드 후 재시작
```

기본값은 `APP_URL=https://photos.netdoctor.shop`, `TRUST_PROXY=true`입니다(환경변수로 덮어쓸 수 있음).

DB와 사진은 Docker 볼륨(`family-photos_pgdata`, `family-photos_photos`)에 있으므로 재배포해도 유지됩니다.

## 서버 접속

```bash
aws ssm start-session --target i-01bccdf9f7e5575d0 --region ap-northeast-2
cd /opt/family-photos/app
sudo docker compose -f docker-compose.yml -f docker-compose.aws.yml logs -f app
```

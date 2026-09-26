# AWS EC2 단일 서버 배포 (HTTP)

EC2 1대(t3.small, 서울 리전)에서 `docker compose`로 앱과 PostgreSQL을 실행합니다. 사진은 로컬 디스크(Docker 볼륨)에 저장됩니다.

> ⚠️ HTTPS가 아니므로 비밀번호와 사진이 암호화되지 않은 채 전송됩니다. 도메인을 연결하면 CloudFront 또는 ALB + ACM으로 HTTPS를 붙이고 `APP_URL`을 `https://...`로 바꾸세요.

| 리소스 | 값 |
| --- | --- |
| 주소 | http://15.164.201.49 (Elastic IP) |
| EC2 | `i-01bccdf9f7e5575d0` (Amazon Linux 2023, t3.small, 30GB gp3 암호화, 2GB swap) |
| 보안 그룹 | `sg-03677a3a4ddb57b0e`: 80 포트만 허용 (SSH 없음, 접속은 SSM Session Manager) |
| IAM 역할 | `family-photos-ec2`: SSM, 배포 버킷 읽기, `/family-photos/*` 파라미터 읽기 |
| 비밀값 | SSM Parameter Store `/family-photos/AUTH_SECRET`, `/family-photos/POSTGRES_PASSWORD` |
| 배포 버킷 | `s3://family-photos-deploy-137181255849` (소스 tar.gz) |
| 백업 | DLM 정책 `policy-06112ddfe18cb057f`: 매일 03:00 KST EBS 스냅샷, 7개 보관 |
| 휴지통 정리 | 인스턴스의 systemd 타이머 `family-photos-purge.timer` (매일 04:00) |

## 재배포

```bash
deploy/aws-ec2/deploy.sh    # 현재 커밋(HEAD)을 업로드하고, EC2에서 빌드 후 재시작
```

DB와 사진은 Docker 볼륨(`family-photos_pgdata`, `family-photos_photos`)에 있으므로 재배포해도 유지됩니다.

## 서버 접속

```bash
aws ssm start-session --target i-01bccdf9f7e5575d0 --region ap-northeast-2
cd /opt/family-photos/app
sudo docker compose -f docker-compose.yml -f docker-compose.aws.yml logs -f app
```

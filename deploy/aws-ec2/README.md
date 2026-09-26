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

## 파일

| 파일 | 역할 |
| --- | --- |
| `cloudformation.yml` | 전체 인프라(EC2 + 초기 설정 스크립트, ALB, ACM, Route 53, 보안 그룹, IAM, 배포 버킷, 스냅샷 백업) |
| `bootstrap-secrets.sh` | `AUTH_SECRET`, `POSTGRES_PASSWORD`를 SSM Parameter Store에 생성(있으면 유지) |
| `deploy.sh` | 현재 커밋을 S3에 올리고 SSM으로 EC2에서 빌드·재시작 |
| `remote-deploy.sh` | EC2에서 실행: 소스 받기, `.env` 작성, `docker compose up` |
| `docker-compose.aws.yml` | 운영용 override(80 포트, DB 포트 비노출, 로그 크기 제한) |

> 현재 운영 서버(위 표)는 AWS CLI로 직접 만든 것이며 CloudFormation 스택이 아닙니다. `cloudformation.yml`은 같은 구성을 새로 만들 때 쓰는 템플릿입니다.

## 새 환경 만들기 (CloudFormation)

```bash
export AWS_DEFAULT_REGION=ap-northeast-2
STACK=family-photos
deploy/aws-ec2/bootstrap-secrets.sh /family-photos        # 1) 비밀값

aws cloudformation deploy --stack-name $STACK \
  --template-file deploy/aws-ec2/cloudformation.yml --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    HostName=photos.netdoctor.shop DomainName=netdoctor.shop HostedZoneId=Z02143121ZEQVYIDYL9E2 \
    VpcId=vpc-xxxx SubnetIds=subnet-aaaa,subnet-bbbb \
    SecretsPrefix=/family-photos \
    CertificateArn=arn:aws:acm:ap-northeast-2:...:certificate/...   # 2) 인프라 (인증서를 새로 만들려면 CertificateArn 생략)

STACK_NAME=$STACK deploy/aws-ec2/deploy.sh               # 3) 앱 배포 (EC2 초기 설정이 끝날 때까지 자동 대기)
```

- `SubnetIds`는 서로 다른 AZ의 퍼블릭 서브넷 2개 이상이어야 합니다(ALB 요구사항).
- `CertificateArn`을 비우면 `*.DomainName` 인증서를 새로 만들고 Route 53으로 DNS 검증합니다. 같은 도메인의 인증서가 이미 있으면 그 ARN을 넣으세요. 검증용 CNAME 이름이 같아서, 새로 만든 스택을 지울 때 기존 인증서의 자동 갱신용 레코드까지 지워질 수 있습니다.
- EC2 루트 볼륨(DB·사진)은 스택을 지워도 남도록 `DeleteOnTermination: false`입니다. 필요 없으면 직접 삭제하세요.
- 기존 서버의 데이터를 옮길 때는 EBS 스냅샷에서 볼륨을 만들거나 `pg_dump` + `photos` 볼륨 복사를 사용하세요.

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

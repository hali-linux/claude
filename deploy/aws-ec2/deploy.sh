#!/bin/bash
# 로컬(AWS 자격증명이 있는 곳)에서 실행: 현재 커밋(HEAD)을 EC2에 배포
#   deploy/aws-ec2/deploy.sh                       # 기존(수동 구성) 운영 서버
#   STACK_NAME=family-photos deploy/aws-ec2/deploy.sh   # cloudformation.yml로 만든 스택
set -euo pipefail
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"

if [ -n "${STACK_NAME:-}" ]; then
  out() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
  INSTANCE_ID="${INSTANCE_ID:-$(out InstanceId)}"
  APP_URL="${APP_URL:-$(out AppUrl)}"
  BUCKET="${BUCKET:-$(out DeployBucket)}"
  PARAM_PREFIX="${PARAM_PREFIX:-$(out SecretsPrefix)}"
fi
INSTANCE_ID="${INSTANCE_ID:-i-01bccdf9f7e5575d0}"
APP_URL="${APP_URL:-https://photos.netdoctor.shop}"
BUCKET="${BUCKET:-family-photos-deploy-137181255849}"
PARAM_PREFIX="${PARAM_PREFIX:-/family-photos}"
# ALB 뒤에서 실행하므로 X-Forwarded-For(ALB가 붙인 마지막 값)를 클라이언트 IP로 사용
TRUST_PROXY="${TRUST_PROXY:-true}"

cd "$(git rev-parse --show-toplevel)"
REV=$(git rev-parse --short HEAD)
KEY="releases/$REV.tar.gz"
git archive --format=tar.gz HEAD | aws s3 cp - "s3://$BUCKET/$KEY"
aws s3 cp deploy/aws-ec2/remote-deploy.sh "s3://$BUCKET/remote-deploy.sh"

ARGS="s3://$BUCKET/$KEY $APP_URL $TRUST_PROXY $PARAM_PREFIX $AWS_DEFAULT_REGION"
CMD_ID=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --comment "family-photos $REV" --timeout-seconds 3600 \
  --parameters "executionTimeout=3600,commands=[\"aws s3 cp s3://$BUCKET/remote-deploy.sh /tmp/remote-deploy.sh --region $AWS_DEFAULT_REGION\",\"bash /tmp/remote-deploy.sh $ARGS\"]" \
  --query Command.CommandId --output text)
echo "SSM command: $CMD_ID (빌드에 5~10분 걸립니다)"
while true; do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 15 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -n 40
echo "결과: $STATUS"
[ "$STATUS" = Success ]

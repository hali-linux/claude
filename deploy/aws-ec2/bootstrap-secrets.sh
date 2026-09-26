#!/bin/bash
# 앱 비밀값을 SSM Parameter Store(SecureString)에 만든다. 이미 있으면 건드리지 않는다.
#   deploy/aws-ec2/bootstrap-secrets.sh [/family-photos]
set -euo pipefail
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
PREFIX="${1:-/family-photos}"

create() {
  if aws ssm get-parameter --name "$PREFIX/$1" >/dev/null 2>&1; then
    echo "$PREFIX/$1: 이미 있음"
  else
    aws ssm put-parameter --name "$PREFIX/$1" --type SecureString --value "$2" >/dev/null
    echo "$PREFIX/$1: 생성"
  fi
}
create AUTH_SECRET "$(openssl rand -base64 48)"
create POSTGRES_PASSWORD "$(openssl rand -hex 24)"

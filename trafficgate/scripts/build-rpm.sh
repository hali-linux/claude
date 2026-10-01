#!/usr/bin/env bash
# dist/ 의 배포 압축 파일로 RPM 을 만든다. (make rpm 에서 호출)
#   Rocky 9 에서: sudo dnf install -y rpm-build && make rpm
set -euo pipefail

VERSION="${VERSION:?VERSION 필요}"
GOARCH="${GOARCH:-amd64}"
RELEASE="${RELEASE:-1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${ROOT}/dist"
TARBALL="${DIST}/trafficgate-${VERSION}-linux-${GOARCH}.tar.gz"

case "$GOARCH" in
  amd64) RPMARCH=x86_64 ;;
  arm64) RPMARCH=aarch64 ;;
  *) echo "지원하지 않는 GOARCH: $GOARCH" >&2; exit 1 ;;
esac

command -v rpmbuild >/dev/null || { echo "rpmbuild 가 필요합니다 (dnf install rpm-build)" >&2; exit 1; }
[[ -f "$TARBALL" ]] || { echo "배포 파일이 없습니다: $TARBALL (먼저 make dist)" >&2; exit 1; }

TOP="${DIST}/rpmbuild"
rm -rf "$TOP"
mkdir -p "$TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
cp "$TARBALL" "$TOP/SOURCES/"
cp "${ROOT}/packaging/rpm/trafficgate.spec" "$TOP/SPECS/"

rpmbuild -bb \
  --define "_topdir ${TOP}" \
  --define "tg_version ${VERSION}" \
  --define "tg_goarch ${GOARCH}" \
  --define "tg_release ${RELEASE}" \
  --define "dist .el9" \
  --define "_build_id_links none" \
  --target "${RPMARCH}" \
  "$TOP/SPECS/trafficgate.spec"

find "$TOP/RPMS" -name '*.rpm' -exec cp {} "$DIST/" \;
ls -1 "$DIST"/*.rpm

#!/bin/bash
set -euo pipefail
################################################################################
#                                                                              #
#   Step 18: Terraform 설치 / Terraform install for tf-export                  #
#                                                                              #
#   콘솔 리소스를 Terraform 코드로 내보내는 기능(tf-export)이 쓰는 Terraform     #
#   바이너리를 서버에 설치하고 AWS 프로바이더를 미리 받아 둡니다.               #
#   Installs the pinned Terraform binary used by tf-export and pre-warms the   #
#   AWS provider cache so jobs do not download it at run time.                 #
#                                                                              #
#   설치 / Installs (idempotent):                                              #
#     .tools/terraform                       Terraform 1.9.8 (SHA256 검증)      #
#     data/tf-export/plugin-cache/           AWS provider 5.100.0 cache        #
#                                                                              #
#   사용법 / Usage: bash scripts/18-setup-terraform.sh   (ec2-user, 서버에서)   #
#   환경 변수 (선택) / Env: TF_VERSION, TF_AWS_PROVIDER_VERSION                #
#                                                                              #
################################################################################

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

# Refuse root: files must belong to the dashboard user / root 실행 거부: 파일은 대시보드 사용자 소유여야 함
if [ "$(id -u)" -eq 0 ]; then
  echo -e "${RED}root로 실행하지 마세요. ec2-user로 실행하세요 / do not run as root${NC}"
  exit 1
fi

TF_VERSION="${TF_VERSION:-1.9.8}"
PROVIDER_VERSION="${TF_AWS_PROVIDER_VERSION:-5.100.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT/.tools"
TF_BIN="$TOOLS_DIR/terraform"
CACHE_DIR="$ROOT/data/tf-export/plugin-cache"

# Detect CPU architecture / CPU 아키텍처 감지
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *) echo -e "${RED}지원하지 않는 아키텍처 / unsupported arch: $(uname -m)${NC}"; exit 1 ;;
esac

mkdir -p "$TOOLS_DIR" "$CACHE_DIR"

# Single cleanup for all temp dirs / 모든 임시 디렉터리를 한 번에 정리
TMP=""; WARM=""
trap 'rm -rf "${TMP:-}" "${WARM:-}"' EXIT

# Skip the download when the right version is present / 이미 설치되어 있으면 다운로드 생략
if [ -x "$TF_BIN" ] && CHECKPOINT_DISABLE=1 "$TF_BIN" version 2>/dev/null | head -1 | grep -q "v${TF_VERSION}\$"; then
  echo -e "${CYAN}[1/2] Terraform ${TF_VERSION} 이미 설치됨 / already installed — 건너뜀${NC}"
else
  echo -e "${CYAN}[1/2] Terraform ${TF_VERSION} (${ARCH}) 다운로드 / download${NC}"
  BASE="https://releases.hashicorp.com/terraform/${TF_VERSION}"
  ZIP="terraform_${TF_VERSION}_linux_${ARCH}.zip"
  SUMS="terraform_${TF_VERSION}_SHA256SUMS"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/$ZIP" "$BASE/$ZIP"
  curl -fsSL -o "$TMP/$SUMS" "$BASE/$SUMS"

  # Verify checksum for our zip only / 해당 zip의 체크섬만 검증
  (cd "$TMP" && grep " ${ZIP}\$" "$SUMS" | sha256sum -c -)

  # Unzip (python3 fallback when unzip is missing) / 압축 해제 (unzip 없으면 python3 사용)
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$TMP/$ZIP" terraform -d "$TMP/out"
  else
    python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract('terraform', sys.argv[2])" "$TMP/$ZIP" "$TMP/out"
  fi
  install -m 0755 "$TMP/out/terraform" "$TF_BIN"
fi

# Pre-warm the provider cache; jobs read this unpacked layout as a filesystem mirror and never download / 프로바이더 캐시 미리 받기; 작업은 이 풀린 구조를 파일시스템 미러로 읽고 다운로드하지 않음
echo -e "${CYAN}[2/2] AWS provider ${PROVIDER_VERSION} 캐시 준비 / pre-warm provider cache${NC}"
WARM="$(mktemp -d)"
cat > "$WARM/main.tf" <<TF
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "${PROVIDER_VERSION}"
    }
  }
}
TF
(cd "$WARM" && TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1 TF_CLI_CONFIG_FILE=/dev/null TF_PLUGIN_CACHE_DIR="$CACHE_DIR" "$TF_BIN" init -input=false >/dev/null)

# Verify the mirror layout the jobs need / 작업이 필요로 하는 미러 구조 확인
PROVIDER_DIR="$CACHE_DIR/registry.terraform.io/hashicorp/aws/${PROVIDER_VERSION}/linux_${ARCH}"
if ! ls "$PROVIDER_DIR"/terraform-provider-aws_* >/dev/null 2>&1; then
  echo -e "${RED}프로바이더 캐시가 없습니다 / provider not found: $PROVIDER_DIR${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}완료 / Done${NC}"
echo "  Terraform : $("$TF_BIN" version | head -1)  ($TF_BIN)"
echo "  Provider  : hashicorp/aws ${PROVIDER_VERSION}  ($PROVIDER_DIR)"

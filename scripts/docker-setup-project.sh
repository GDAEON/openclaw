#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DOCKER_DIR="${ROOT_DIR}/.docker"

export OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${PROJECT_DOCKER_DIR}/openclaw}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${PROJECT_DOCKER_DIR}/workspace}"

mkdir -p "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_WORKSPACE_DIR"

exec "${ROOT_DIR}/docker-setup.sh"

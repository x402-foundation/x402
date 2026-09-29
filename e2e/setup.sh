#!/bin/bash
set -e

# Parse command line arguments
INCLUDE_LEGACY=false
VERBOSE=false

for arg in "$@"; do
  case $arg in
    --legacy)
      INCLUDE_LEGACY=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -h|--help)
      echo "Usage: ./setup.sh [options]"
      echo ""
      echo "Runs install/build for all e2e components (local scripts or language defaults)"
      echo ""
      echo "Options:"
      echo "  --legacy         Include legacy (v1) implementations"
      echo "  -v, --verbose    Show detailed output"
      echo "  -h, --help       Show this help message"
      exit 0
      ;;
  esac
done

echo "🚀 X402 E2E Setup"
echo "=================="
echo ""

if [ "$INCLUDE_LEGACY" = true ]; then
  echo "📚 Including legacy (v1) implementations"
  echo ""
fi

TOTAL=0
SUCCESS=0
FAILED=0
FAILED_COMPONENTS=()

SKIP_NAMES="shared node_modules .venv __pycache__ .next"

is_skipped() {
  local name=$1
  for skip in $SKIP_NAMES; do
    if [ "$name" = "$skip" ]; then
      return 0
    fi
  done
  return 1
}

run_step() {
  local label=$1
  local dir=$2
  shift 2
  local cmd=("$@")

  if [ "$VERBOSE" = true ]; then
    if (cd "$dir" && "${cmd[@]}"); then
      echo "   ✅ $label completed"
      return 0
    fi
    echo "   ❌ $label failed"
    return 1
  fi

  if (cd "$dir" && "${cmd[@]}") > /dev/null 2>&1; then
    echo "   ✅ $label completed"
    return 0
  fi
  echo "   ❌ $label failed"
  echo "   💡 Run with -v for detailed output"
  return 1
}

default_install() {
  local dir=$1
  if [ -f "$dir/go.mod" ]; then
    run_step "Install" "$dir" go mod tidy
    return $?
  fi
  if [ -f "$dir/pyproject.toml" ]; then
    run_step "Install" "$dir" uv sync
    return $?
  fi
  return 0
}

default_build() {
  local dir=$1
  local name
  name=$(basename "$dir")

  if [ -f "$dir/go.mod" ]; then
    run_step "Build" "$dir" go build -o "$name" .
    return $?
  fi
  if [ -f "$dir/pyproject.toml" ]; then
    run_step "Build" "$dir" uv sync --reinstall-package x402
    return $?
  fi
  return 0
}

has_setup_work() {
  local dir=$1
  [ -f "$dir/install.sh" ] || [ -f "$dir/build.sh" ] || [ -f "$dir/go.mod" ] || [ -f "$dir/pyproject.toml" ]
}

setup_component() {
  local dir=$1
  local label=$2

  TOTAL=$((TOTAL + 1))
  echo ""
  echo "📦 $label"

  local component_success=true

  if [ -f "$dir/install.sh" ]; then
    if ! run_step "Install" "$dir" bash install.sh; then
      component_success=false
    fi
  else
    if ! default_install "$dir"; then
      component_success=false
    fi
  fi

  if [ -f "$dir/build.sh" ]; then
    if ! run_step "Build" "$dir" bash build.sh; then
      component_success=false
    fi
  else
    if ! default_build "$dir"; then
      component_success=false
    fi
  fi

  if [ "$component_success" = true ]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_COMPONENTS+=("$label")
  fi
}

# Walk role/language/transport/component (v2 layout)
process_role_v2() {
  local role_dir=$1
  local role_type=$2

  if [ ! -d "$role_dir" ]; then
    return
  fi

  for language_dir in "$role_dir"/*; do
    [ -d "$language_dir" ] || continue
    local language
    language=$(basename "$language_dir")
    case "$language" in
      typescript|go|python) ;;
      *) continue ;;
    esac

    for transport_dir in "$language_dir"/*; do
      [ -d "$transport_dir" ] || continue
      local transport
      transport=$(basename "$transport_dir")
      case "$transport" in
        http|mcp) ;;
        *) continue ;;
      esac

      if [ "$transport" = "mcp" ]; then
        if has_setup_work "$transport_dir"; then
          setup_component "$transport_dir" "$role_type/$language/mcp"
        fi
        continue
      fi

      for component_dir in "$transport_dir"/*; do
        [ -d "$component_dir" ] || continue
        local component
        component=$(basename "$component_dir")
        if is_skipped "$component"; then
          continue
        fi
        if has_setup_work "$component_dir"; then
          setup_component "$component_dir" "$role_type/$language/http/$component"
        fi
      done
    done
  done
}

# Flat legacy layout
process_directory_flat() {
  local base_dir=$1
  local type=$2
  local recurse_into=${3:-""}

  if [ ! -d "$base_dir" ]; then
    return
  fi

  for dir in "$base_dir"/*; do
    if [ -d "$dir" ]; then
      local basename
      basename=$(basename "$dir")

      if is_skipped "$basename"; then
        continue
      fi

      if [ "$basename" = "$recurse_into" ] || [ "$basename" = "local" ]; then
        process_directory_flat "$dir" "$type" ""
        continue
      fi

      if has_setup_work "$dir"; then
        setup_component "$dir" "$type/$basename"
      fi
    fi
  done
}

echo "======================================================="
echo "Starting Setup Process"
echo "======================================================="

process_role_v2 "servers" "server"
process_role_v2 "clients" "client"
process_directory_flat "facilitators" "facilitator" "external-proxies"

if [ "$INCLUDE_LEGACY" = true ]; then
  process_role_v2 "legacy/servers" "legacy-server"
  process_role_v2 "legacy/clients" "legacy-client"
  process_directory_flat "legacy/facilitators" "legacy-facilitator"
fi

echo ""
echo ""
echo "═══════════════════════════════════════════════════════"
echo "                 Setup Summary"
echo "═══════════════════════════════════════════════════════"
echo "✅ Successful: $SUCCESS"
echo "❌ Failed:     $FAILED"
echo "📈 Total:      $TOTAL"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "❌ FAILED COMPONENTS:"
  for component in "${FAILED_COMPONENTS[@]}"; do
    echo "   • $component"
  done
  echo ""
  exit 1
else
  echo ""
  echo "✅ All setup tasks completed successfully!"
  echo "💡 You can now run: pnpm test"
  echo ""
fi

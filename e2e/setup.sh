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
      echo "Runs install.sh and build.sh for all e2e components"
      echo ""
      echo "Options:"
      echo "  --legacy         Include legacy (v1) implementations"
      echo "  -v, --verbose    Show detailed output"
      echo "  -h, --help       Show this help message"
      echo ""
      echo "Examples:"
      echo "  ./setup.sh                  # Setup v2 implementations only"
      echo "  ./setup.sh --legacy         # Setup v2 and legacy"
      echo "  ./setup.sh --legacy -v      # Setup with verbose output"
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

# Track results
TOTAL=0
SUCCESS=0
FAILED=0
FAILED_COMPONENTS=()

# Function to setup a component
setup_component() {
  local dir=$1
  local name=$(basename "$dir")
  local type=$2
  
  TOTAL=$((TOTAL + 1))
  
  echo ""
  echo "📦 $type: $name"
  
  local component_success=true
  
  # Run install.sh if it exists
  if [ -f "$dir/install.sh" ]; then
    if [ "$VERBOSE" = true ]; then
      if (cd "$dir" && bash install.sh); then
        echo "   ✅ Install completed"
      else
        echo "   ❌ Install failed"
        component_success=false
      fi
    else
      if (cd "$dir" && bash install.sh) > /dev/null 2>&1; then
        echo "   ✅ Install completed"
      else
        echo "   ❌ Install failed"
        echo "   💡 Run with -v for detailed output"
        component_success=false
      fi
    fi
  fi
  
  # Run build.sh if it exists
  if [ -f "$dir/build.sh" ]; then
    if [ "$VERBOSE" = true ]; then
      if (cd "$dir" && bash build.sh); then
        echo "   ✅ Build completed"
      else
        echo "   ❌ Build failed"
        component_success=false
      fi
    else
      if (cd "$dir" && bash build.sh) > /dev/null 2>&1; then
        echo "   ✅ Build completed"
      else
        echo "   ❌ Build failed"
        echo "   💡 Run with -v for detailed output"
        component_success=false
      fi
    fi
  fi
  
  if [ "$component_success" = true ]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_COMPONENTS+=("$type/$name")
  fi
}

# Function to process directory (with optional recursion for nested structures)
process_directory() {
  local base_dir=$1
  local type=$2
  local recurse_into=${3:-""}
  
  if [ ! -d "$base_dir" ]; then
    return
  fi
  
  for dir in "$base_dir"/*; do
    if [ -d "$dir" ] && [ ! "$(basename "$dir")" = "node_modules" ]; then
      local basename=$(basename "$dir")
      
      # Handle special nested directories (external-proxies, local)
      if [ "$basename" = "$recurse_into" ] || [ "$basename" = "local" ]; then
        # Recurse into nested directory
        process_directory "$dir" "$type" ""
        continue
      fi
      
      # Check if component has install.sh or build.sh
      if [ -f "$dir/install.sh" ] || [ -f "$dir/build.sh" ]; then
        setup_component "$dir" "$type"
      fi
    fi
  done
}

echo "======================================================="
echo "Starting Setup Process"
echo "======================================================="

# Setup servers
process_directory "servers" "server"

# Setup clients
process_directory "clients" "client"

# Setup facilitators (including external-proxies and local subdirectories)
process_directory "facilitators" "facilitator" "external-proxies"

# Setup legacy if requested
if [ "$INCLUDE_LEGACY" = true ]; then
  process_directory "legacy/servers" "server"
  process_directory "legacy/clients" "client"
  process_directory "legacy/facilitators" "facilitator"
fi

# Print summary
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
  echo "═══════════════════════════════════════════════════════"
  echo "❌ Setup completed with errors"
  echo "═══════════════════════════════════════════════════════"
  echo ""
  exit 1
else
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "✅ All setup tasks completed successfully!"
  echo "═══════════════════════════════════════════════════════"
  echo ""
  echo "💡 You can now run: pnpm test"
  if [ "$INCLUDE_LEGACY" = false ]; then
    echo "   Or with legacy: pnpm test --legacy"
  fi
  echo ""
fi

